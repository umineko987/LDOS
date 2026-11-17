package discovery

import (
	"context"
	"net/http"

	"ldos/backend/internal/gallery"
)

// The runner implements this optional interface without widening Capturer for
// unrelated adapters. Tests can implement it alongside their Capture stub.
type danbooruAuthResolver interface {
	ResolveDanbooruAuth(context.Context, gallery.Request) (http.Header, error)
}

type danbooruHeadersKey struct{}

func danbooruRequestHeaders(ctx context.Context) http.Header {
	headers, _ := ctx.Value(danbooruHeadersKey{}).(http.Header)
	return headers
}

func (a *DanbooruAdapter) danAuthContext(ctx context.Context, request Request, target string) (context.Context, error) {
	resolver, ok := a.Transport.Gallery.(danbooruAuthResolver)
	if !ok {
		if request.CredentialsRef != "" || request.CookiesFile != "" || request.ConfigFile != "" || len(request.ExtraArgs) != 0 {
			return nil, &Error{Code: "danbooru_auth_unavailable", Message: "Danbooru API 回退无法保留已配置的认证：认证解析器不可用"}
		}
		return ctx, nil
	}
	headers, err := resolver.ResolveDanbooruAuth(ctx, gallery.Request{
		URL: target, Site: "danbooru", ConfigFile: request.ConfigFile,
		CookiesFile: request.CookiesFile, CredentialsRef: request.CredentialsRef,
		ExtraArgs: request.ExtraArgs, HTTPTimeout: duration(request.Policy.HTTPTimeout),
	})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		// Resolver diagnostics are deliberately not interpolated: configuration
		// loaders and test implementations may include credential material.
		return nil, &Error{Code: "danbooru_auth_unavailable", Message: "Danbooru API 回退无法解析或保留已配置的认证，请检查配置、完整用户名/API key 及有效 Cookie"}
	}
	return context.WithValue(ctx, danbooruHeadersKey{}, headers.Clone()), nil
}
