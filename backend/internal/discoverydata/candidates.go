package discoverydata

import (
	"net/url"
	"regexp"
	"strings"
)

func author(site string, id, name, display any, profile, works string) object {
	n, d := text(name, 200), text(display, 200)
	if n == nil && d == nil && id == nil {
		return nil
	}
	return object{"id": text(id, 200), "site": site, "kind": "author", "name": n, "display_name": d, "url": nullable(profile), "works_url": nullable(stringOr(first(works, profile)))}
}
func related(a object) []object {
	if a == nil {
		return nil
	}
	return []object{a}
}
func twitterCandidate(d object) (object, []object) {
	id := integer(d["tweet_id"])
	if id == nil {
		return nil, nil
	}
	user := obj(d["author"])
	name := text(user["name"], 200)
	profile := ""
	if name != nil {
		profile = "https://x.com/" + str(name)
	}
	works := ""
	if profile != "" {
		works = profile + "/media"
	}
	a := author("twitter", user["id"], name, user["nick"], profile, works)
	u := "https://x.com/i/web/status/" + str(id)
	if profile != "" {
		u = profile + "/status/" + str(id)
	}
	return object{"id": str(id), "site": "twitter", "kind": "work", "title": first(text(d["content"], 500), "Post "+str(id)), "url": u, "download_url": u, "thumbnail_url": nil, "media_count": first(integer(d["count"]), 1), "author": nilIfMap(a), "metadata": object{"date": text(d["date"], 100), "language": text(d["lang"], 50), "favorite_count": integer(d["favorite_count"]), "retweet_count": integer(d["retweet_count"]), "reply_count": integer(d["reply_count"]), "view_count": integer(d["view_count"]), "hashtags": list(d["hashtags"], 50), "sensitive": d["sensitive"]}}, related(a)
}
func nilIfMap(m object) any {
	if m == nil {
		return nil
	}
	return m
}
func pixivCandidate(d object) (object, []object) {
	id := integer(d["id"])
	if id == nil {
		return nil, nil
	}
	user := obj(d["user"])
	aid := integer(user["id"])
	profile, works := "", ""
	if aid != nil {
		profile = "https://www.pixiv.net/users/" + str(aid)
		works = profile + "/artworks"
	}
	a := author("pixiv", aid, user["account"], user["name"], profile, works)
	u := "https://www.pixiv.net/artworks/" + str(id)
	tags := []string{}
	for _, v := range sequence(d["tags"]) {
		s := str(v)
		if m := obj(v); m != nil {
			s = str(first(m["name"], m["translated_name"], ""))
		}
		if s != "" {
			tags = append(tags, s)
			if len(tags) == 50 {
				break
			}
		}
	}
	return object{"id": str(id), "site": "pixiv", "kind": "work", "title": first(text(d["title"], 500), "Artwork "+str(id)), "url": u, "download_url": u, "thumbnail_url": nil, "media_count": first(integer(d["count"]), integer(d["page_count"]), 1), "author": nilIfMap(a), "metadata": object{"date": text(first(d["date"], d["create_date"]), 100), "rating": text(d["rating"], 50), "type": text(d["type"], 50), "tags": tags, "total_bookmarks": integer(d["total_bookmarks"]), "total_view": integer(d["total_view"])}}, related(a)
}
func danbooruCandidate(d object) (object, []object) {
	id := integer(d["id"])
	if id == nil {
		return nil, nil
	}
	artists := list(first(d["tags_artist"], d["tag_string_artist"]), 20)
	authors := []object{}
	for _, name := range artists {
		authors = append(authors, author("danbooru", nil, name, strings.ReplaceAll(name, "_", " "), "https://danbooru.donmai.us/artists?search%5Bname%5D="+url.QueryEscape(name), "https://danbooru.donmai.us/posts?tags="+url.QueryEscape(name)))
	}
	copyrights := list(first(d["tags_copyright"], d["tag_string_copyright"]), 10)
	u := "https://danbooru.donmai.us/posts/" + str(id)
	source := text(d["source"], 8192)
	downloadable := text(d["file_url"], 8192) != nil
	var downloadURL, unavailableReason any
	if downloadable {
		downloadURL = u
	} else {
		unavailableReason = "missing_file_url"
	}
	var a any
	if len(authors) > 0 {
		a = authors[0]
	}
	return object{"id": str(id), "site": "danbooru", "kind": "post", "title": first(strings.Join(copyrights, " / "), "Post "+str(id)), "url": u, "download_url": downloadURL, "downloadable": downloadable, "download_unavailable_reason": unavailableReason, "source_url": source, "thumbnail_url": first(text(d["preview_file_url"], 8192), text(d["large_file_url"], 8192), text(d["file_url"], 8192)), "media_count": 1, "author": a, "metadata": object{"date": text(first(d["date"], d["created_at"]), 100), "rating": text(d["rating"], 50), "score": integer(d["score"]), "width": integer(d["image_width"]), "height": integer(d["image_height"]), "artists": artists, "characters": list(first(d["tags_character"], d["tag_string_character"]), 30), "copyrights": copyrights}}, authors
}
func danbooruQueue(u string, d object) (object, []object) {
	name := text(d["name"], 200)
	if name == nil {
		return nil, nil
	}
	id := integer(d["id"])
	profile := "https://danbooru.donmai.us/artists?search%5Bname%5D=" + url.QueryEscape(str(name))
	if id != nil {
		profile = "https://danbooru.donmai.us/artists/" + str(id)
	}
	a := author("danbooru", id, name, strings.ReplaceAll(str(name), "_", " "), profile, u)
	names := stringsOf(d["other_names"])
	if len(names) > 50 {
		names = names[:50]
	}
	a["other_names"] = names
	a["group_name"] = text(d["group_name"], 200)
	a["origin"] = "danbooru_artist_directory"
	return nil, related(a)
}
func exhentaiCandidate(d object, source string) (object, []object) {
	id := integer(first(d["gid"], d["gallery_id"]))
	if id == nil {
		return nil, nil
	}
	token := text(first(d["token"], d["gallery_token"]), 100)
	u := source
	if token != nil {
		host := "e-hentai.org"
		if strings.Contains(source, "exhentai.org") {
			host = "exhentai.org"
		}
		u = "https://" + host + "/g/" + str(id) + "/" + str(token) + "/"
	}
	var a object
	if uploader := text(d["uploader"], 200); uploader != nil {
		works := "https://e-hentai.org/?f_search=" + url.QueryEscape("uploader:\""+str(uploader)+"$\"")
		a = author("exhentai", nil, uploader, uploader, works, works)
	}
	return object{"id": str(id), "site": "exhentai", "kind": "gallery", "title": first(text(d["title"], 500), "Gallery "+str(id)), "url": u, "download_url": u, "thumbnail_url": text(d["thumb"], 8192), "media_count": integer(d["filecount"]), "author": nilIfMap(a), "metadata": object{"title_jpn": text(d["title_jpn"], 500), "category": text(first(d["eh_category"], d["category"]), 100), "language": text(d["language"], 100), "rating": text(d["rating"], 50), "tags": list(d["tags"], 50)}}, related(a)
}

var galleryIDPattern = regexp.MustCompile(`/g/(\d+)/`)

func exhentaiQueue(u string, d object) (object, []object) {
	id := integer(d["gallery_id"])
	if id == nil {
		if m := galleryIDPattern.FindStringSubmatch(u); m != nil {
			id = integer(m[1])
		}
	}
	if id == nil {
		return nil, nil
	}
	if !strings.HasSuffix(u, "/") {
		u += "/"
	}
	return object{"id": str(id), "site": "exhentai", "kind": "gallery", "title": "Gallery " + str(id), "url": u, "download_url": u, "thumbnail_url": nil, "media_count": nil, "author": nil, "metadata": object{"gallery_token": text(d["gallery_token"], 100)}}, nil
}

const pawchiveRoot = "https://pawchive.pw"

func pawchiveThumbnail(u string) string {
	const prefix = "https://file.pawchive.pw/data/"
	if strings.HasPrefix(u, prefix) {
		return "https://img.pawchive.pw/thumbnail/data/" + strings.TrimPrefix(u, prefix)
	}
	return u
}
func pawchiveCandidate(d object) (object, []object) {
	id, service, user := text(d["id"], 100), text(d["service"], 50), text(d["user"], 100)
	if id == nil || service == nil || user == nil {
		return nil, nil
	}
	count := integer(d["count"])
	if count != nil && intValue(count) <= 0 {
		return nil, nil
	}
	profile := pawchiveRoot + "/" + str(service) + "/user/" + str(user)
	a := object{"site": "pawchive", "id": user, "name": text(d["username"], 300), "url": profile, "works_url": profile}
	u := profile + "/post/" + str(id)
	return object{"id": id, "site": "pawchive", "kind": "post", "title": first(text(d["title"], 300), "Post "+str(id)), "url": u, "download_url": u, "thumbnail_url": nil, "media_count": count, "author": a, "metadata": object{"service": service, "published": text(d["published"], 100)}}, related(a)
}
func pawchiveQueue(u string, d object) (object, []object) {
	id, service := text(d["id"], 100), text(d["service"], 50)
	if id == nil || service == nil {
		return nil, nil
	}
	if b, ok := d["ever_imported"].(bool); ok && !b {
		return nil, nil
	}
	profile := pawchiveRoot + "/" + str(service) + "/user/" + str(id)
	name := text(d["name"], 300)
	return object{"id": str(service) + ":" + str(id), "site": "pawchive", "kind": "account", "title": first(name, str(service)+"/"+str(id)), "url": first(u, profile), "download_url": profile, "thumbnail_url": pawchiveRoot + "/icons/" + str(service) + "/" + str(id), "media_count": nil, "author": object{"site": "pawchive", "id": id, "name": name, "url": profile, "works_url": profile}, "metadata": object{"service": service, "favorited": integer(d["favorited"]), "updated": integer(d["updated"]), "ever_imported": truth(d["ever_imported"])}}, nil
}
