import { VIVERSE_CONFIG } from "./ViverseConfig";

export const logDiagnostics = () => {
  console.log("--- VIVERSE Diagnostic Report ---");
  console.log(`App ID: ${VIVERSE_CONFIG.APP_ID}`);
  console.log(`Iframe: ${window.self !== window.top}`);
  console.log(`URL: ${window.location.href}`);

  const vSdk = (window).vSdk || (window).viverse || (window).VIVERSE_SDK;
  if (vSdk) {
    console.log("SDK Detected: YES");
    console.log("Bridge Ready:", vSdk.bridge ? vSdk.bridge.isReady : "N/A");
  } else {
    console.warn("SDK Detected: NO");
  }

  console.log("---------------------------------");
};
