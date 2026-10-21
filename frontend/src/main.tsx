import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { Analytics } from "@vercel/analytics/react";
import { Toaster } from "./components/ui/sonner";

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<Toaster />
		<App />
		{/* Cookieless page-view analytics. It sees which pages load, never audio. */}
		<Analytics />
	</StrictMode>,
);
