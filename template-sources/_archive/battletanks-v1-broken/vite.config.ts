import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const appId = env.VITE_VIVERSE_CLIENT_ID || env.VITE_VIVERSE_APP_ID || "YOUR_APP_ID";

  return {
    base: "./",
    define: {
      "import.meta.env.VITE_VIVERSE_CLIENT_ID": JSON.stringify(appId),
      "import.meta.env.VITE_VIVERSE_APP_ID": JSON.stringify(appId)
    }
  };
});
