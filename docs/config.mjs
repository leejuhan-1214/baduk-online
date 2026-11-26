const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const remote = 'wss://baduk-online-relay.corallily16.chatgpt.site/ws';
export const WS_URL = isLocal
  ? `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
  : remote;
