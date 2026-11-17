package authorization

import (
	"math"
	"regexp"
)

func safeTime(value any) any {
	var n float64
	switch v := value.(type) {
	case float64:
		n = v
	case *float64:
		if v == nil {
			return nil
		}
		n = *v
	case int:
		n = float64(v)
	default:
		return nil
	}
	if math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n > 4102444800 {
		return nil
	}
	return n
}
func safeCount(value any) int {
	n, ok := value.(int)
	if !ok || n < 0 {
		return 0
	}
	return min(n, 100000)
}
func object(value any) map[string]any { result, _ := value.(map[string]any); return result }
func text(value any) string           { result, _ := value.(string); return result }

var sessionID = regexp.MustCompile(`^[0-9a-f]{32}$`)

func vaultSession(value any, site string) any {
	row := object(value)
	state := text(row["state"])
	if !sessionID.MatchString(text(row["session_id"])) {
		return nil
	}
	if !active(state) && state != "authorized" && state != "cancelled" && state != "timed_out" && state != "failed" && state != "token_ready" {
		return nil
	}
	result := map[string]any{"session_id": row["session_id"], "state": state, "created_at": safeTime(row["created_at"]), "expires_at": safeTime(row["expires_at"]), "site": site}
	if site == "twitter" || site == "exhentai" {
		result["cookie_count"] = safeCount(row["cookie_count"])
	}
	return result
}
func VaultStatus(row map[string]any) map[string]any {
	site := text(row["site"])
	label, method, actions := "", "", []string{}
	switch site {
	case "danbooru":
		label, method = "Danbooru", "anonymous"
	case "pawchive":
		label, method = "Pawchive", "anonymous"
	case "pixiv":
		label, method, actions = "Pixiv", "oauth", []string{"oauth", "clear"}
	case "twitter":
		label, method, actions = "X / Twitter", "managed_browser", []string{"managed_browser_login", "clear"}
	case "exhentai":
		label, method, actions = "EH", "managed_browser", []string{"managed_browser_login", "clear"}
	default:
		return nil
	}
	state := text(row["state"])
	if state != "ready" && state != "authorized" && state != "authorizing" {
		state = "required"
	}
	authorized := row["authorized"] == true
	invalidated := safeTime(row["invalidated_at"])
	summary := "后端当前没有可供任务使用的托管授权材料。"
	switch {
	case method == "anonymous":
		summary = "后端声明此目标使用公开访问，不需要登录材料。"
	case state == "authorizing":
		summary = "共享授权浏览器流程正在进行。"
	case invalidated != nil:
		summary = "后端已在实际访问中判定现有授权材料失效。"
	case authorized:
		summary = "后端检测到托管授权材料；此状态不代表远端验证成功。"
	}
	result := map[string]any{"site": site, "label": label, "method": method, "state": state, "authorized": authorized, "summary": summary, "updated_at": safeTime(row["updated_at"]), "invalidated_at": invalidated, "actions": actions}
	if method == "managed_browser" {
		cookie := object(row["cookies"])
		result["browser"], result["profile"] = "project_chrome", "shared"
		result["cookies"] = map[string]any{"present": cookie["present"] == true, "valid": cookie["valid"] == true, "cookie_count": safeCount(cookie["cookie_count"]), "updated_at": safeTime(cookie["updated_at"])}
		result["login"] = vaultSession(row["login"], site)
	} else if method == "oauth" {
		result["browser"], result["profile"], result["oauth"] = "project_chrome", "shared", vaultSession(row["oauth"], site)
	}
	return result
}
func vaultProxy(row map[string]any) map[string]any {
	source := text(row["source"])
	if source != "runtime" && source != "config" {
		source = "none"
	}
	return map[string]any{"proxy_url": maskedProxy(text(row["proxy_url"])), "source": source, "credentials_redacted": row["credentials_redacted"] == true, "browser_running": row["browser_running"] == true, "restart_pending": row["restart_pending"] == true, "updated_at": safeTime(row["updated_at"])}
}
func vaultProfile(row map[string]any) map[string]any {
	return map[string]any{"shared": row["shared"] == true, "present": row["present"] == true, "running": row["running"] == true, "resetting": row["resetting"] == true, "sites": []string{"twitter", "pixiv", "exhentai"}}
}
func vaultRuntime(row map[string]any) map[string]any {
	available := row["available"] == true
	name := text(row["name"])
	if !available || (name != "Google Chrome" && name != "Chromium" && name != "Microsoft Edge" && name != "Chromium 浏览器") {
		name = ""
	}
	source := text(row["source"])
	if source != "auto" && source != "configured" {
		source = "none"
	}
	message := "未检测到支持的浏览器，请手动选择"
	if available {
		message = "浏览器可用于站点授权"
	}
	return map[string]any{"available": available, "name": nullable(name), "source": source, "message": message}
}
func vaultStatuses(row map[string]any) map[string]any {
	items := []map[string]any{}
	if rows, ok := row["items"].([]map[string]any); ok {
		for _, r := range rows {
			if projected := VaultStatus(r); projected != nil {
				items = append(items, projected)
			}
		}
	}
	return map[string]any{"items": items, "browser_profile": vaultProfile(object(row["browser_profile"])), "authorization_proxy": vaultProxy(object(row["authorization_proxy"])), "managed": row["managed"] == true, "secrets_exposed": false, "response_profile": "vault"}
}
func vaultLogin(row map[string]any) map[string]any {
	status := VaultStatus(object(row["status"]))
	return map[string]any{"session": vaultSession(row["session"], text(status["site"])), "status": status}
}
