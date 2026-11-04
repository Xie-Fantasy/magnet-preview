# Application boundary

`ProductionPreviewManager` and `RequestCoordinator` coordinate cache-first preview lookup, shared in-flight requests and bounded retry policy. The background owns the provider and exposes preview operations to the extension surfaces. Favorites and disposable preview cache have separate application contracts.
