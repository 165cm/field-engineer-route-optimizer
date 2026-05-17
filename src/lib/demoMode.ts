// Demo mode is enabled at build time via VITE_DEMO_MODE=true.
// It is intended for the GitHub Pages preview where there is no Node.js
// backend, so:
//   - Maps API calls fall back to the client-side Maps JS SDK
//   - AI parsing (Gemini) is disabled, since the API key cannot be safely
//     exposed in a static bundle even with referrer restrictions
//   - The Pro plan is enabled by default so reviewers can see every feature,
//     but the user can still toggle Free in the header to inspect gating
export const isDemoMode = (): boolean => {
  try {
    // Vite replaces import.meta.env.* at build time
    return (import.meta as any).env?.VITE_DEMO_MODE === 'true';
  } catch {
    return false;
  }
};
