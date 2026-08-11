/**
 * ============================================================
 * FILE: frontend/src/App.jsx
 * OWNER: Person 3 + Person 9
 * Routes between Connect and Build; holds connected state.
 * Adds a view switch between the classic Build form and the
 * conversational AI Chat builder.
 * ============================================================
 */

import { useState } from 'react';
import ConnectScreen from './components/ConnectScreen';
import BuildScreen from './components/BuildScreen';
import ChatBuilder from './components/ChatBuilder';
import { disconnect } from './api';

export default function App() {
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState('build'); // 'build' | 'chat'

  // Lifted from ConnectScreen after a successful test; threaded into BuildScreen.
  const [elementorPro, setElementorPro] = useState(false); // whether the site has Pro
  const [allowPro, setAllowPro] = useState(false);         // user's chosen widget mode
  const [unsplashKey, setUnsplashKey] = useState('');
  const [geminiKey, setGeminiKey] = useState('');
  const [brandContext, setBrandContext] = useState('');

  async function handleDisconnect() {
    try { await disconnect(); } catch (_) { /* ignore */ }
    setConnected(false);
    setView('build');
  }

  function handleConnected(settings) {
    setElementorPro(!!settings.elementorPro);
    setAllowPro(!!settings.allowPro);
    setUnsplashKey(settings.unsplashKey || '');
    setGeminiKey(settings.geminiKey || '');
    setBrandContext(settings.brandContext || '');
    setConnected(true);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">AI → Elementor Publisher</div>
        {connected && (
          <div className="topbar-right">
            <nav className="viewnav">
              <button
                className={view === 'build' ? 'viewnav-btn active' : 'viewnav-btn'}
                onClick={() => setView('build')}
              >
                Build
              </button>
              <button
                className={view === 'chat' ? 'viewnav-btn active' : 'viewnav-btn'}
                onClick={() => setView('chat')}
              >
                AI Chat
              </button>
            </nav>
            <button className="ghost" onClick={handleDisconnect}>Disconnect</button>
          </div>
        )}
      </header>

      <main className="main">
        {!connected && <ConnectScreen onConnected={handleConnected} />}

        {connected && view === 'build' && (
          <BuildScreen
            elementorPro={elementorPro}
            allowPro={allowPro}
            setAllowPro={setAllowPro}
            unsplashKey={unsplashKey}
            geminiKey={geminiKey}
            brandContext={brandContext}
          />
        )}

        {connected && view === 'chat' && (
          <ChatBuilder
            elementorPro={elementorPro}
            allowPro={allowPro}
            unsplashKey={unsplashKey}
            geminiKey={geminiKey}
            brandContext={brandContext}
          />
        )}
      </main>

      <footer className="foot">Runs locally · backend :8787 · frontend :5173</footer>
    </div>
  );
}
