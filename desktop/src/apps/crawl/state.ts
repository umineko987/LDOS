import {
  emptyCrawlSnapshot,
  selectedCandidateKeys,
  visibleCandidateKeys,
  type CrawlBusy,
  type CrawlCandidate,
  type CrawlCandidateKey,
  type CrawlErrorPresentation,
  type CrawlFilterMode,
  type CrawlPhase,
  type CrawlSnapshot,
  type CrawlSourceKey,
  type CrawlSuggestion,
} from "./model";

export interface CrawlState extends CrawlSnapshot {
  readonly activeSourceKey: CrawlSourceKey | "";
  readonly phase: CrawlPhase;
  readonly busy: CrawlBusy;
  readonly error: CrawlErrorPresentation | null;
  readonly message: string;
  readonly suggestions: readonly CrawlSuggestion[];
  readonly operationalAvailable: boolean;
}

export interface CrawlStore {
  subscribe(listener: (state: CrawlState) => void): () => void;
  getState(): CrawlState;
  beginSearch(): boolean;
  commitSearch(snapshot: CrawlSnapshot): boolean;
  failSearch(error: CrawlErrorPresentation): boolean;
  setSuggestions(suggestions: readonly CrawlSuggestion[]): boolean;
  setActiveSource(key: CrawlSourceKey): boolean;
  setCandidateSelected(key: CrawlCandidateKey, selected: boolean): boolean;
  setCandidatesSelected(keys: readonly CrawlCandidateKey[], selected: boolean): boolean;
  moveSource(key: CrawlSourceKey, direction: -1 | 1): boolean;
  moveCandidate(key: CrawlCandidateKey, direction: -1 | 1): boolean;
  setWeakEvidenceVisible(visible: boolean): boolean;
  setEhTagFilter(key: string, mode: CrawlFilterMode | ""): boolean;
  clearEhTagFilter(): boolean;
  setOperationalAvailable(available: boolean): boolean;
  beginCreate(): boolean;
  finishCreate(message: string): boolean;
  failCreate(error: CrawlErrorPresentation): boolean;
  setMessage(message: string): boolean;
  destroy(): void;
}

function freezeState(state: CrawlState): CrawlState {
  return Object.freeze(state);
}

function move<T>(items: readonly T[], index: number, target: number): readonly T[] | null {
  if (index < 0 || target < 0 || target >= items.length || index === target) return null;
  const changed = [...items];
  [changed[index], changed[target]] = [changed[target], changed[index]];
  return Object.freeze(changed);
}

function updatedCandidates(
  state: CrawlState,
  keys: ReadonlySet<CrawlCandidateKey>,
  selected: boolean,
): Readonly<Record<CrawlCandidateKey, CrawlCandidate>> | null {
  let changed: Record<CrawlCandidateKey, CrawlCandidate> | null = null;
  for (const key of keys) {
    const candidate = state.candidates[key];
    if (!candidate || candidate.selected === selected) continue;
    changed ??= { ...state.candidates };
    changed[key] = Object.freeze({ ...candidate, selected });
  }
  return changed ? Object.freeze(changed) : null;
}

export function crawlSources(state: CrawlState) {
  return state.sourceOrder.map((key) => state.sources[key]).filter(Boolean);
}

export function crawlCandidates(state: CrawlState, sourceKey: CrawlSourceKey = state.activeSourceKey as CrawlSourceKey) {
  return visibleCandidateKeys(state, sourceKey).map((key) => state.candidates[key]).filter(Boolean);
}

export function selectedCrawlCandidates(state: CrawlState) {
  return selectedCandidateKeys(state).map((key) => state.candidates[key]).filter(Boolean);
}

export function visibleEhFacets(state: CrawlState, query = "") {
  const source = state.activeSourceKey ? state.sources[state.activeSourceKey] : null;
  if (source?.site !== "exhentai") return Object.freeze([]);
  const visibleTags = new Set(
    crawlCandidates(state, source.key).flatMap((candidate) => candidate.tags.map(({ key }) => key)),
  );
  const normalized = query.trim().toLowerCase();
  return Object.freeze(source.tagFacets.flatMap((facet) => {
    const tags = facet.tags.filter((tag) => (
      visibleTags.has(tag.key)
      && (!normalized || `${facet.namespace} ${facet.label} ${tag.value}`.toLowerCase().includes(normalized))
    ));
    return tags.length ? [Object.freeze({ ...facet, tags: Object.freeze(tags) })] : [];
  }));
}

export function createCrawlStore(): CrawlStore {
  const empty = emptyCrawlSnapshot();
  let state = freezeState({
    ...empty,
    activeSourceKey: "",
    phase: "initial",
    busy: "",
    error: null,
    message: "输入关键词并选择搜索来源。",
    suggestions: Object.freeze([]),
    operationalAvailable: true,
  });
  const listeners = new Set<(state: CrawlState) => void>();
  let destroyed = false;
  let searchHadError = false;

  const publish = (next: CrawlState): boolean => {
    if (destroyed || next === state) return false;
    state = freezeState(next);
    for (const listener of listeners) listener(state);
    return true;
  };

  const service: CrawlStore = {
    subscribe(listener) {
      listener(state);
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => state,
    beginSearch() {
      if (state.busy) return false;
      return publish({
        ...state,
        phase: "loading",
        busy: "search",
        error: null,
        suggestions: Object.freeze([]),
        message: "正在搜索多个站点，离开页面将取消本次搜索……",
      });
    },
    commitSearch(snapshot) {
      if (state.busy !== "search") return false;
      const recovered = searchHadError;
      searchHadError = false;
      return publish({
        ...snapshot,
        activeSourceKey: snapshot.sourceOrder[0] ?? "",
        phase: recovered ? "recovery" : "settled",
        busy: "",
        error: null,
        suggestions: Object.freeze([]),
        operationalAvailable: true,
        message: `搜索完成：${snapshot.addressCount} 个候选，${snapshot.weakEvidenceCount} 个待核实结果。`,
      });
    },
    failSearch(error) {
      if (state.busy !== "search") return false;
      searchHadError = true;
      return publish({
        ...state,
        phase: "error",
        busy: "",
        error,
        message: "搜索失败，上次结果已保留。请检查授权或代理后重试。",
      });
    },
    setSuggestions(suggestions) {
      const next = Object.freeze([...suggestions]);
      if (state.suggestions === suggestions || (
        state.suggestions.length === next.length
        && state.suggestions.every((item, index) => item === next[index])
      )) return false;
      return publish({ ...state, suggestions: next });
    },
    setActiveSource(key) {
      if (!Object.hasOwn(state.sources, key) || state.activeSourceKey === key) return false;
      return publish({ ...state, activeSourceKey: key });
    },
    setCandidateSelected(key, selected) {
      const candidates = updatedCandidates(state, new Set([key]), selected);
      return candidates ? publish({ ...state, candidates }) : false;
    },
    setCandidatesSelected(keys, selected) {
      const candidates = updatedCandidates(state, new Set(keys), selected);
      return candidates ? publish({ ...state, candidates }) : false;
    },
    moveSource(key, direction) {
      const index = state.sourceOrder.indexOf(key);
      const sourceOrder = move(state.sourceOrder, index, index + direction);
      return sourceOrder ? publish({ ...state, sourceOrder }) : false;
    },
    moveCandidate(key, direction) {
      const candidate = state.candidates[key];
      if (!candidate) return false;
      const visible = visibleCandidateKeys(state, candidate.sourceKey);
      const visibleIndex = visible.indexOf(key);
      const target = visible[visibleIndex + direction];
      if (!target) return false;
      const order = state.candidateOrder[candidate.sourceKey];
      const moved = move(order, order.indexOf(key), order.indexOf(target));
      if (!moved) return false;
      return publish({
        ...state,
        candidateOrder: Object.freeze({ ...state.candidateOrder, [candidate.sourceKey]: moved }),
      });
    },
    setWeakEvidenceVisible(visible) {
      if (state.showWeakEvidence === visible) return false;
      let candidates = state.candidates;
      if (!visible) {
        const weak = new Set(Object.values(state.candidates)
          .filter((candidate) => candidate.weak)
          .map(({ key }) => key));
        candidates = updatedCandidates(state, weak, false) ?? candidates;
      }
      return publish({ ...state, showWeakEvidence: visible, candidates });
    },
    setEhTagFilter(key, mode) {
      if (!/^[a-z]+:[^\u0000-\u001f\u007f]{1,160}$/.test(key)) throw new TypeError("invalid_eh_tag_key");
      if (mode !== "" && mode !== "include" && mode !== "exclude") throw new TypeError("invalid_eh_tag_mode");
      if (state.ehTagFilter[key] === mode || (!mode && !Object.hasOwn(state.ehTagFilter, key))) return false;
      const filter = { ...state.ehTagFilter } as Record<string, CrawlFilterMode>;
      if (mode) filter[key] = mode;
      else delete filter[key];
      return publish({ ...state, ehTagFilter: Object.freeze(filter) });
    },
    clearEhTagFilter() {
      if (!Object.keys(state.ehTagFilter).length) return false;
      return publish({ ...state, ehTagFilter: Object.freeze(Object.create(null)) });
    },
    setOperationalAvailable(available) {
      if (state.operationalAvailable === available) return false;
      return publish({
        ...state,
        operationalAvailable: available,
        message: available ? state.message : "操作地址已安全清理，需要重新搜索后才能创建批次。",
      });
    },
    beginCreate() {
      if (state.busy || !state.operationalAvailable || !selectedCandidateKeys(state).length) return false;
      return publish({
        ...state,
        busy: "crawl",
        error: null,
        message: "正在创建批次，请勿重复提交……",
      });
    },
    finishCreate(message) {
      if (state.busy !== "crawl") return false;
      return publish({ ...state, busy: "", error: null, message });
    },
    failCreate(error) {
      if (state.busy !== "crawl") return false;
      return publish({
        ...state,
        busy: "",
        error,
        message: "批次创建失败，当前选择和顺序已保留。请修正后重试。",
      });
    },
    setMessage(message) {
      if (state.message === message) return false;
      return publish({ ...state, message });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
    },
  };
  return Object.freeze(service);
}
