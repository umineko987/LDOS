package modelservice

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"

	"io"
	"math"
	_ "modernc.org/sqlite"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type QueryError struct {
	ExitCode int
	Message  string
}

func (e *QueryError) Error() string             { return e.Message }
func queryError(code int, message string) error { return &QueryError{code, message} }

type vocabulary struct {
	names, categories, order      []string
	fingerprint, modelFingerprint string
}

func (s *Service) describe(spec Spec) (vocabulary, error) {
	v := vocabulary{}
	root := filepath.Join(s.deps.Settings.Tagger.ModelDir, spec.Key)
	if !installed(s.deps.Settings.Tagger.ModelDir, spec) {
		return v, queryError(4, "模型未安装: "+spec.Key)
	}
	switch spec.Adapter {
	case "wd_onnx", "timm_canary":
		f, e := os.Open(filepath.Join(root, "selected_tags.csv"))
		if e != nil {
			return v, e
		}
		defer f.Close()
		reader := csv.NewReader(f)
		header, e := reader.Read()
		if e != nil {
			return v, e
		}
		nameCol, catCol := -1, -1
		for i, k := range header {
			if k == "name" {
				nameCol = i
			}
			if k == "category" {
				catCol = i
			}
		}
		if nameCol < 0 || catCol < 0 {
			return v, queryError(4, "selected_tags.csv 缺少字段")
		}
		for {
			row, e := reader.Read()
			if e == io.EOF {
				break
			}
			if e != nil {
				return v, e
			}
			name := strings.TrimSpace(row[nameCol])
			cat := map[string]string{"0": "general", "4": "character", "9": "rating"}[strings.TrimSpace(row[catCol])]
			if name == "" || cat == "" {
				return v, queryError(4, "selected_tags.csv 出现未知行")
			}
			v.names = append(v.names, name)
			v.categories = append(v.categories, cat)
		}
	case "cl_onnx":
		var data struct {
			Num        int               `json:"num_tags"`
			Tags       map[string]string `json:"idx_to_tag"`
			Categories map[string]string `json:"tag_to_category"`
		}
		if e := readJSON(filepath.Join(root, "v2_00", "model_vocabulary.json"), &data); e != nil {
			return v, e
		}
		if data.Num < 1 || data.Num > 1000000 {
			return v, queryError(4, "CL 词表大小无效")
		}
		v.names = make([]string, data.Num)
		v.categories = make([]string, data.Num)
		for k, name := range data.Tags {
			i, e := strconv.Atoi(k)
			if e != nil || i < 0 || i >= data.Num {
				return v, queryError(4, "CL 词表索引越界")
			}
			v.names[i] = name
			v.categories[i] = strings.ToLower(data.Categories[name])
		}
		for i, name := range v.names {
			if name == "" || v.categories[i] == "" {
				return v, queryError(4, "CL 词表不完整")
			}
		}
	case "pixai_hf":
		var data struct {
			Tags   []string            `json:"tags"`
			Splits [][]json.RawMessage `json:"tags_split"`
		}
		if e := readJSON(filepath.Join(root, "config.json"), &data); e != nil {
			return v, e
		}
		v.names = data.Tags
		for _, split := range data.Splits {
			var cat string
			var count int
			if len(split) != 2 || json.Unmarshal(split[0], &cat) != nil || json.Unmarshal(split[1], &count) != nil || count < 0 || count > len(data.Tags) {
				return v, queryError(4, "tags_split 条目非法")
			}
			for i := 0; i < count; i++ {
				v.categories = append(v.categories, cat)
			}
		}
		if len(v.names) != len(v.categories) {
			return v, queryError(4, "tags_split 总数与 tags 不一致")
		}
	default:
		return v, queryError(4, "未知适配器类型")
	}
	if len(v.names) == 0 {
		return v, queryError(4, "词表为空")
	}
	h := sha256.New()
	for i, name := range v.names {
		h.Write([]byte(name))
		h.Write([]byte{0})
		h.Write([]byte(v.categories[i]))
		h.Write([]byte{0})
		if !contains(v.order, v.categories[i]) {
			v.order = append(v.order, v.categories[i])
		}
	}
	v.fingerprint = hex.EncodeToString(h.Sum(nil))
	sum := sha256.Sum256([]byte(spec.Adapter + ":v1" + spec.Revision + v.fingerprint))
	v.modelFingerprint = hex.EncodeToString(sum[:])
	return v, nil
}
func readJSON(path string, out any) error {
	if e := safePath(path); e != nil {
		return e
	}
	b, e := os.ReadFile(path)
	if e != nil {
		return e
	}
	return json.Unmarshal(b, out)
}

type queryOptions struct {
	floor                 float64
	categories            []string
	thresholds            map[string]float64
	modelThresholds       map[string]map[string]float64
	keep, escape, compute bool
	batch                 int
}

func parseQueryOptions(command string, args []string, models []Spec) (queryOptions, error) {
	o := queryOptions{floor: .05, batch: 8, thresholds: map[string]float64{}, modelThresholds: map[string]map[string]float64{}}
	bad := queryError(2, "无效打标查询参数")
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch arg {
		case "--progress-json":
			continue
		case "--keep-underscores":
			o.keep = true
		case "--escape-parens":
			o.escape = true
		case "--compute":
			if command != "candidates" {
				return o, bad
			}
			o.compute = true
		case "--model-threshold":
			if i+3 >= len(args) {
				return o, bad
			}
			model, cat := args[i+1], args[i+2]
			v, e := strconv.ParseFloat(args[i+3], 64)
			supported := false
			for _, s := range models {
				_, ok := s.DefaultThresholds[cat]
				supported = supported || s.Key == model && ok
			}
			if !supported || e != nil || math.IsNaN(v) || v < .01 || v > .99 {
				return o, bad
			}
			if o.modelThresholds[model] == nil {
				o.modelThresholds[model] = map[string]float64{}
			}
			o.modelThresholds[model][cat] = v
			i += 3
		case "--categories":
			if i+1 >= len(args) {
				return o, bad
			}
			i++
			for _, c := range strings.Split(args[i], ",") {
				if c = strings.TrimSpace(c); c != "" {
					o.categories = append(o.categories, c)
				}
			}
		default:
			if i+1 >= len(args) {
				return o, bad
			}
			i++
			if arg == "--batch-size" {
				v, e := strconv.Atoi(args[i])
				if e != nil || v < 1 {
					return o, bad
				}
				o.batch = v
				continue
			}
			v, e := strconv.ParseFloat(args[i], 64)
			if e != nil || math.IsNaN(v) || math.IsInf(v, 0) {
				return o, bad
			}
			if arg == "--floor" {
				if v < 0 || v > 1 {
					return o, bad
				}
				o.floor = v
			} else if strings.HasPrefix(arg, "--") && strings.HasSuffix(arg, "-thr") {
				category := strings.TrimSuffix(strings.TrimPrefix(arg, "--"), "-thr")
				if !contains([]string{"general", "character", "rating", "copyright", "quality", "meta", "style"}, category) {
					return o, bad
				}
				o.thresholds[category] = v
			} else {
				return o, bad
			}
		}
	}
	return o, nil
}

type lookupInput struct{ path, hash string }

var knownHash = regexp.MustCompile(`^[0-9a-f]{64}$`)
var plainTag = regexp.MustCompile(`^[a-z0-9_]+$`)

func collectInputs(lines []string) ([]lookupInput, error) {
	result := []lookupInput{}
	for _, line := range lines {
		line = strings.TrimPrefix(strings.TrimSuffix(line, "\r"), "\ufeff")
		if strings.TrimSpace(line) == "" {
			continue
		}
		if strings.ContainsAny(line, "\x00\n") {
			return nil, queryError(2, "输入路径无效")
		}
		item := lookupInput{path: line}
		if len(line) > 65 && line[64] == '\t' && knownHash.MatchString(line[:64]) {
			item.hash, item.path = line[:64], line[65:]
		}
		item.path = filepath.Clean(item.path)
		if st, e := os.Stat(item.path); item.hash == "" && e == nil && st.IsDir() {
			e = filepath.WalkDir(item.path, func(path string, d os.DirEntry, e error) error {
				if e != nil {
					return nil
				}
				if d.IsDir() {
					if path != item.path && strings.HasPrefix(d.Name(), ".") {
						return filepath.SkipDir
					}
					return nil
				}
				if d.Type()&os.ModeSymlink == 0 && contains([]string{".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff"}, strings.ToLower(filepath.Ext(path))) {
					result = append(result, lookupInput{path: path})
				}
				return nil
			})
			if e != nil {
				return nil, e
			}
		} else {
			result = append(result, item)
		}
	}
	return result, nil
}
func contentHash(ctx context.Context, path string) (string, error) {
	f, e := os.Open(path)
	if e != nil {
		return "", e
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, 1<<20)
	for {
		if e = ctx.Err(); e != nil {
			return "", e
		}
		n, e := f.Read(buf)
		h.Write(buf[:n])
		if e == io.EOF {
			break
		}
		if e != nil {
			return "", e
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func openScoreDB(path string) (*sql.DB, error) {
	if e := safePath(path); e != nil {
		return nil, e
	}
	if _, e := os.Stat(path); errors.Is(e, os.ErrNotExist) {
		return nil, nil
	} else if e != nil {
		return nil, e
	}
	u := url.URL{Scheme: "file", Path: path}
	db, e := sql.Open("sqlite", u.String()+"?mode=ro&_pragma=busy_timeout(30000)")
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	return db, nil
}
func scores(ctx context.Context, db *sql.DB, fingerprint, hash string, dim int) ([]float64, error) {
	if db == nil {
		return nil, nil
	}
	var dimension int
	var vector []byte
	e := db.QueryRowContext(ctx, "SELECT dimension, vector FROM scores WHERE model_fingerprint=? AND file_hash=?", fingerprint, hash).Scan(&dimension, &vector)
	if errors.Is(e, sql.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		if strings.Contains(e.Error(), "no such table: scores") {
			return nil, nil
		}
		return nil, e
	}
	if dimension != dim || len(vector) != dim*4 {
		return nil, nil
	}
	result := make([]float64, dim)
	for i := range result {
		result[i] = float64(math.Float32frombits(binary.LittleEndian.Uint32(vector[i*4:])))
		if math.IsNaN(result[i]) || math.IsInf(result[i], 0) {
			return nil, nil
		}
	}
	return result, nil
}
func effective(spec Spec, o queryOptions) map[string]float64 {
	v := map[string]float64{}
	for k, n := range spec.DefaultThresholds {
		v[k] = n
	}
	for k, n := range o.thresholds {
		v[k] = n
	}
	for k, n := range o.modelThresholds[spec.Key] {
		v[k] = n
	}
	return v
}
func selectedCategories(v vocabulary, o queryOptions) []string {
	if len(o.categories) > 0 {
		return o.categories
	}
	return v.order
}
func selectTags(spec Spec, v vocabulary, values []float64, o queryOptions, seen map[string]bool) []Record {
	tags := []Record{}
	thresholds := effective(spec, o)
	for _, category := range selectedCategories(v, o) {
		threshold, ok := thresholds[category]
		if !ok {
			threshold = .5
			if category == "rating" {
				threshold = 0
			}
		}
		indices := []int{}
		for i, c := range v.categories {
			if c == category {
				indices = append(indices, i)
			}
		}
		if category == "rating" && len(indices) > 0 {
			best := indices[0]
			for _, i := range indices[1:] {
				if values[i] > values[best] {
					best = i
				}
			}
			indices = []int{best}
		}
		for _, i := range indices {
			if values[i] < threshold {
				continue
			}
			name := v.names[i]
			label := name
			if !o.keep && plainTag.MatchString(label) {
				label = strings.ReplaceAll(label, "_", " ")
			}
			if o.escape {
				label = strings.NewReplacer("(", "\\(", ")", "\\)").Replace(label)
			}
			if seen[label] {
				continue
			}
			seen[label] = true
			tags = append(tags, Record{"name": name, "text": label, "category": category, "score": math.RoundToEven(values[i]*1e5) / 1e5, "model": spec.Key})
		}
	}
	return tags
}

// Query implements the tagger CLI's read-only JSON-line protocol natively.
// Model and vocabulary fingerprints intentionally match Python cache keys.
func (s *Service) Query(ctx context.Context, command string, models, inputLines, extraArgs []string) ([]Record, error) {
	if command != "candidates" && command != "compose" {
		return nil, queryError(2, "unsupported tagger query")
	}
	ctx, cancel := context.WithTimeout(ctx, 600*time.Second)
	defer cancel()
	models = unique(models)
	if len(models) == 0 {
		return nil, queryError(2, "至少选择一个模型")
	}
	specs := []Spec{}
	for _, key := range models {
		v, ok := s.spec(key)
		if !ok {
			return nil, queryError(2, "未登记的打标模型: "+key)
		}
		specs = append(specs, v)
	}
	opts, e := parseQueryOptions(command, extraArgs, specs)
	if e != nil {
		return nil, e
	}
	inputs, e := collectInputs(inputLines)
	if e != nil {
		return nil, e
	}
	if len(inputs) == 0 {
		return nil, queryError(1, "没有找到图片")
	}
	if opts.compute {
		return s.computeCandidates(ctx, models, inputs, extraArgs, opts.batch)
	}
	vocabs := make([]vocabulary, len(specs))
	header := []Record{}
	for i, spec := range specs {
		v, e := s.describe(spec)
		if e != nil {
			return nil, e
		}
		vocabs[i] = v
		entry := Record{"key": spec.Key, "adapter": spec.Adapter, "revision": spec.Revision, "fingerprint": v.modelFingerprint, "vocabulary_fingerprint": v.fingerprint, "vocabulary_size": len(v.names), "categories": v.order, "default_thresholds": spec.DefaultThresholds}
		if command == "compose" {
			entry["thresholds"] = effective(spec, opts)
			entry["selected_categories"] = selectedCategories(v, opts)
		}
		header = append(header, entry)
	}
	head := Record{"type": "models", "models": header}
	if command == "candidates" {
		head["floor"] = opts.floor
	}
	out := []Record{head}
	db, e := openScoreDB(s.deps.Settings.Tagger.CachePath)
	if e != nil {
		return nil, e
	}
	if db != nil {
		defer db.Close()
	}
	counts := map[string]int{"ok": 0, "missing_scores": 0, "decode_error": 0, "unreadable": 0}
	for _, input := range inputs {
		if e = ctx.Err(); e != nil {
			return nil, e
		}
		if input.hash == "" {
			input.hash, _ = contentHash(ctx, input.path)
		}
		var sha any
		if input.hash != "" {
			sha = input.hash
		}
		missing := []string{}
		candidates := Record{}
		tags := []Record{}
		seen := map[string]bool{}
		for i, spec := range specs {
			var values []float64
			if input.hash != "" {
				values, e = scores(ctx, db, vocabs[i].modelFingerprint, input.hash, len(vocabs[i].names))
				if e != nil {
					return nil, e
				}
			}
			if values == nil {
				missing = append(missing, spec.Key)
				continue
			}
			if command == "compose" {
				tags = append(tags, selectTags(spec, vocabs[i], values, opts, seen)...)
			} else {
				rows := [][]any{}
				for j, value := range values {
					if value >= opts.floor || vocabs[i].categories[j] == "rating" {
						rows = append(rows, []any{vocabs[i].names[j], vocabs[i].categories[j], value})
					}
				}
				candidates[spec.Key] = rows
			}
		}
		status := "ok"
		if input.hash == "" {
			status = "unreadable"
		} else if len(missing) > 0 {
			status = "missing_scores"
		}
		counts[status]++
		row := Record{"path": input.path, "sha256": sha, "status": status, "missing_models": missing}
		if command == "candidates" {
			row["type"], row["models"] = "candidates", candidates
		} else {
			labels := []string{}
			for _, t := range tags {
				labels = append(labels, text(t["text"]))
			}
			row["type"], row["tags"], row["caption"] = "result", tags, strings.Join(labels, ", ")
		}
		out = append(out, row)
	}
	done := Record{"type": "done", "command": command, "total": len(inputs)}
	for k, n := range counts {
		done[k] = n
	}
	if command == "candidates" {
		done["inferred"] = Record{}
	}
	return append(out, done), nil
}
func (s *Service) computeCandidates(ctx context.Context, models []string, inputs []lookupInput, args []string, batch int) ([]Record, error) {
	queryArgs := []string{}
	for _, v := range args {
		if v != "--compute" {
			queryArgs = append(queryArgs, v)
		}
	}
	lines := []string{}
	for _, v := range inputs {
		lines = append(lines, v.path)
	}
	before, e := s.Query(ctx, "candidates", models, lines, queryArgs)
	if e != nil {
		return nil, e
	}
	missing := []string{}
	for _, r := range before {
		if r["status"] == "missing_scores" {
			missing = append(missing, text(r["path"]))
		}
	}
	if len(missing) == 0 {
		return before, nil
	}
	finished := make(chan Record, 1)
	_, e = s.Tag(ctx, TagRequest{Models: models, Inputs: missing, BatchSize: batch, OnFinished: func(_ context.Context, result Record) error { finished <- result; return nil }})
	if e != nil {
		return nil, e
	}
	var result Record
	select {
	case result = <-finished:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	if result["status"] != "succeeded" {
		return nil, queryError(4, text(result["message"]))
	}
	after, e := s.Query(ctx, "candidates", models, lines, queryArgs)
	if e != nil {
		return nil, e
	}
	last, _ := result["last_result"].(Record)
	inferred := Record{}
	if per, ok := last["per_model"].(map[string]any); ok {
		for key, v := range per {
			if stats, ok := v.(map[string]any); ok {
				inferred[key] = stats["inferred"]
			}
		}
	}
	after[len(after)-1]["inferred"] = inferred
	return after, nil
}

// Stable ordering is useful to integrations displaying supported categories.
func (s *Service) ModelKeys() []string {
	keys := []string{}
	for _, v := range s.specs {
		keys = append(keys, v.Key)
	}
	sort.Strings(keys)
	return keys
}
