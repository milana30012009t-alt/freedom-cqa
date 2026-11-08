// Deployment configuration (kept in a separate file so no inline script is needed — CSP-safe).
// For a Microsoft Dynamics 365 web resource set apiBase to the CQA server origin,
// e.g. 'https://cqa.example.kz', and add that origin to CORS_ORIGINS on the server.
window.CQA_CONFIG = window.CQA_CONFIG || {
  apiBase: '',
};
