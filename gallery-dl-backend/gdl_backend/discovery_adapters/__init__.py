"""Source-specific discovery collaborators used behind DiscoveryService."""

from .danbooru import DanbooruDiscoveryAdapter
from .exhentai import ExHentaiDiscoveryAdapter

__all__ = ["DanbooruDiscoveryAdapter", "ExHentaiDiscoveryAdapter"]
