package discoverydata

// DanbooruCandidate converts a post API row using the same rules as DataJob.
func DanbooruCandidate(data map[string]any) (map[string]any, []map[string]any) {
	candidate, authors := danbooruCandidate(data)
	return candidate, nonnilAuthors(authors)
}

// DanbooruArtistQueue converts an artist-directory row into author evidence.
func DanbooruArtistQueue(url string, data map[string]any) (map[string]any, []map[string]any) {
	candidate, authors := danbooruQueue(url, data)
	return candidate, nonnilAuthors(authors)
}

// ExhentaiDirectoryCandidate converts gallery metadata into a gallery candidate.
func ExhentaiDirectoryCandidate(data map[string]any, sourceURL string) (map[string]any, []map[string]any) {
	candidate, authors := exhentaiCandidate(data, sourceURL)
	return candidate, nonnilAuthors(authors)
}

func nonnilAuthors(authors []map[string]any) []map[string]any {
	if authors == nil {
		return []map[string]any{}
	}
	return authors
}

func TagKey(value string) string { return tagKey(value) }

func TagCategoryName(category int) string {
	switch category {
	case 0:
		return "general"
	case 1:
		return "artist"
	case 3:
		return "copyright"
	case 4:
		return "character"
	case 5:
		return "meta"
	default:
		return "general"
	}
}

func IsDNSErrorCode(code string) bool {
	switch code {
	case "invalid_network_target", "proxy_dns_failed", "encrypted_dns_unavailable",
		"encrypted_dns_redirect", "encrypted_dns_http_error", "encrypted_dns_protocol",
		"encrypted_dns_status_error", "encrypted_dns_nxdomain", "encrypted_dns_no_answer",
		"encrypted_dns_response_too_large":
		return true
	default:
		return false
	}
}
