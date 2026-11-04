# Provider boundary

`whatsLinkProvider.ts` owns the sole WhatsLink transport and maps provider responses into neutral preview results. Only the background-owned application path may construct it; Popup, My Page, and content code must not call the provider directly. Requests send a minimal BTIH-only Magnet after consent, and returned screenshot URLs are restricted to the verified WhatsLink HTTPS origin.
