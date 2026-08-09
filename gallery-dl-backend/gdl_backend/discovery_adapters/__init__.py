"""Source-specific discovery collaborators used behind DiscoveryService."""

from .danbooru import DanbooruDiscoveryAdapter
from .exhentai import ExHentaiDiscoveryAdapter
from .gallery_dl import GalleryDlDiscoveryAdapter, PawchiveDiscoveryAdapter

__all__ = [
    "DanbooruDiscoveryAdapter",
    "ExHentaiDiscoveryAdapter",
    "GalleryDlDiscoveryAdapter",
    "PawchiveDiscoveryAdapter",
]
