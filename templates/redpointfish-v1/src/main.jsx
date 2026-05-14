import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

const VERSION_NAME = "1.1.0-auth-preflight-gate";

console.log(`[VIVERSE] Initializing Version: ${VERSION_NAME}`);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
