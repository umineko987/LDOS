"""Resolve the worker's effective Danbooru authentication without network I/O."""
from __future__ import annotations

import os
from urllib.parse import urlsplit


class AuthResolutionError(Exception):
    pass


def resolve_auth(argv: list[str]) -> dict[str, str]:
    from gallery_dl import config, extractor, option, util
    import requests

    args = option.build_parser().parse_args(argv)
    # Mirror gallery_dl.main's configuration order. ConfigAction values (including
    # credentials_ref injected by worker_entry) are global overrides, not defaults.
    if args.config_type:
        config.default(args.config_type)
    if args.config_load:
        config.load(strict=True)
    if args.configs_extra:
        config.load(args.configs_extra, strict=True)
    if args.configs_json:
        config.load(args.configs_json, strict=True, loads=util.json_loads)
    if args.configs_yaml:
        import yaml
        config.load(args.configs_yaml, strict=True, loads=yaml.safe_load)
    if args.configs_toml:
        try:
            import tomllib as toml
        except ImportError:
            import toml
        config.load(args.configs_toml, strict=True, loads=toml.loads)
    if args.cookies_from_browser:
        raise AuthResolutionError("unsupported_cookies")
    for opts in args.options:
        config.set(*opts)
    if env := config.getg("environment"):
        if isinstance(env, dict):
            env = env.items()
        for key, value in env:
            os.environ[key] = util.expand_path(value) if config.getg("environment-expand", True) else value

    if len(args.urls) != 1:
        raise AuthResolutionError("invalid_configuration")
    target = urlsplit(args.urls[0])
    if target.scheme != "https" or target.netloc != "danbooru.donmai.us":
        raise AuthResolutionError("invalid_configuration")
    instance = extractor.find(args.urls[0])
    if instance is None or instance.category != "danbooru" or instance.root != "https://danbooru.donmai.us":
        raise AuthResolutionError("invalid_configuration")

    custom = instance.config("headers") or {}
    if not isinstance(custom, dict):
        raise AuthResolutionError("unsupported_headers")
    headers = dict(custom)
    forbidden = {"host", "proxy-authorization", "connection", "content-length", "transfer-encoding"}
    if any(key.lower() in forbidden for key in headers):
        raise AuthResolutionError("unsupported_headers")

    username, password = instance._get_auth_info()
    if username or password or instance.config("netrc"):
        if not isinstance(username, str) or not username or not isinstance(password, str) or not password:
            raise AuthResolutionError("incomplete_credentials")
        auth = util.HTTPBasicAuth(username, password)
    else:
        if instance.config("password"):
            raise AuthResolutionError("incomplete_credentials")
        auth = None

    instance.cookies = requests.cookies.RequestsCookieJar()
    source = instance.config("cookies")
    if source:
        if isinstance(source, dict):
            instance.cookies_load(source)
        elif isinstance(source, str):
            with open(util.expand_path(source), encoding="utf-8") as stream:
                for cookie in util.cookiestxt_load(stream):
                    instance.cookies.set_cookie(cookie)
        else:
            # Browser access and cookie rotation cannot be faithfully resolved
            # offline; never continue as an anonymous API request.
            raise AuthResolutionError("unsupported_cookies")
    if target.path.rstrip("/") not in {"/posts", "/artists"}:
        raise AuthResolutionError("invalid_configuration")
    endpoint = target._replace(path=target.path.rstrip("/") + ".json", query="", fragment="").geturl()
    prepared = requests.Request("GET", endpoint,
                                headers=headers, cookies=instance.cookies, auth=auth).prepare()
    if source and not prepared.headers.get("Cookie"):
        raise AuthResolutionError("no_valid_cookies")
    return {key: value.decode("latin-1") if isinstance(value, bytes) else value
            for key, value in prepared.headers.items()}
