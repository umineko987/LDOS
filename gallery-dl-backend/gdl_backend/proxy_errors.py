from __future__ import annotations


class ProxyPoolError(RuntimeError):
    pass


class ProxyPoolConflict(ProxyPoolError):
    pass


class ProxyPoolUnavailable(ProxyPoolError):
    """The selected transport core failed to start, so required must not go direct.

    Callers distinguish this hard failure from an ordinary not-running pool:
    prefer/required keep their established behavior for other states, while this
    error must surface a reminder and terminate instead of silently bypassing the
    configured tunnel nodes.
    """
