const CHANNEL = 'magnet-favorites';

export function announceFavoriteChange(): void {
  try {
    const channel = new BroadcastChannel(CHANNEL);
    channel.postMessage('changed');
    channel.close();
  } catch {
    // IndexedDB remains authoritative when cross-document hints are unavailable.
  }
}

export function subscribeFavoriteChanges(refresh: () => void): () => void {
  let channel: BroadcastChannel | undefined;
  try {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = refresh;
  } catch {
    // Recheck whenever this document receives focus.
  }
  window.addEventListener('focus', refresh);
  const onVisibility = () => {
    if (!document.hidden) refresh();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    channel?.close();
    window.removeEventListener('focus', refresh);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
