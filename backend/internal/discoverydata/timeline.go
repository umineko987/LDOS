package discoverydata

import (
	"regexp"
	"strconv"
	"strings"
)

// ParseTimelineOutput uses the gallery-dl dump protocol with strict errors:
// a partial extraction cannot establish whether a timeline has another work.
func ParseTimelineOutput(site, stdout, sourceURL string, limit int) ([]map[string]any, []map[string]any, error) {
	return parseOutput(site, stdout, sourceURL, limit, true)
}

func timelineID(site string, data object) string {
	field := "id"
	if site == "twitter" {
		field = "tweet_id"
	}
	id := stringOr(data[field])
	if timelineWorkID.MatchString(id) {
		return id
	}
	return ""
}

func timelineCandidate(site, id string, data object) object {
	if id == "" {
		return nil
	}
	count, countErr := strconv.Atoi(str(data["count"]))
	var title, fallback, name, downloadURL string
	if site == "pixiv" {
		user := obj(data["user"])
		if countErr != nil {
			count, _ = strconv.Atoi(stringOr(data["page_count"]))
		}
		title, fallback = stringOr(text(data["title"], 500)), "Artwork "+id
		name = stringOr(first(text(user["name"], 200), text(user["account"], 200)))
		downloadURL = "https://www.pixiv.net/artworks/" + id
	} else {
		if !emptyTwitterMarker(data["retweet_id"]) || !emptyTwitterMarker(data["quote_id"]) {
			return nil
		}
		user := obj(data["author"])
		handle := stringOr(user["name"])
		title, fallback = stringOr(text(data["content"], 500)), "Post "+id
		name = stringOr(first(text(user["nick"], 200), text(handle, 200)))
		if timelineHandle(handle) {
			downloadURL = "https://x.com/" + strings.ToLower(handle) + "/status/" + id
		} else {
			downloadURL = "https://x.com/i/web/status/" + id
		}
	}
	return object{"id": id, "title": stringOr(first(title, fallback)), "author": name, "media_count": max(0, count), "download_url": downloadURL, "thumbnail_url": ""}
}

func emptyTwitterMarker(value any) bool {
	s := stringOr(value)
	return s == "" || s == "0"
}

var (
	pixivOriginalImage = regexp.MustCompile(`^/img-original(/img/[0-9]{4}(?:/[0-9]{2}){5}/([0-9]+)_p[0-9]+)\.(?:jpg|jpeg|png|gif|webp)$`)
	pixivPreviewImage  = regexp.MustCompile(`^/(?:c/[A-Za-z0-9_-]+/)?img-master/img/[0-9]{4}(?:/[0-9]{2}){5}/([0-9]+)_(?:p[0-9]+|ugoira0)_(?:master|square|custom)[0-9]+\.(?:jpg|png|webp)$`)
	twitterPreview     = regexp.MustCompile(`^/(?:media/[A-Za-z0-9_-]+|(?:ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)/[0-9]+/(?:pu/)?img/[A-Za-z0-9_-]+|tweet_video_thumb/[A-Za-z0-9_-]+)$`)
)

func timelineThumbnail(site, id, raw string) string {
	u := httpsAddress(raw)
	if u == nil || u.Scheme != "https" {
		return ""
	}
	switch site {
	case "pixiv":
		if u.Host != "i.pximg.net" {
			return ""
		}
		if m := pixivPreviewImage.FindStringSubmatch(u.Path); m != nil && m[1] == id {
			return "https://i.pximg.net" + u.Path
		}
		if m := pixivOriginalImage.FindStringSubmatch(u.Path); m != nil && m[2] == id {
			// This is the CDN preview route used by Pixiv's gallery-dl extractor.
			return "https://i.pximg.net/img-master" + m[1] + "_master1200.jpg"
		}
	case "twitter":
		if u.Host != "pbs.twimg.com" {
			return ""
		}
		base, format, hasExt := strings.Cut(u.Path, ".")
		if !hasExt {
			format = u.Query().Get("format")
		}
		if !twitterPreview.MatchString(base) || !contains([]string{"jpg", "jpeg", "png", "webp", "gif"}, format) {
			return ""
		}
		return "https://pbs.twimg.com" + base + "?format=" + format + "&name=small"
	}
	return ""
}

func timelineWorkThumbnail(site, id string, data object) string {
	if site == "pixiv" {
		for _, field := range []string{"urls", "image_urls"} {
			if urls := obj(data[field]); urls != nil {
				for _, size := range []string{"small", "square_medium", "medium", "regular", "large", "thumb"} {
					if image := timelineThumbnail(site, id, stringOr(urls[size])); image != "" {
						return image
					}
				}
			}
		}
	}
	return ""
}
