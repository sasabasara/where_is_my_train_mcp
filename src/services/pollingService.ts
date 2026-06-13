import { fetchMTAData } from "./mtaService.js";

const POLLING_INTERVAL_MS = 45000; // 45 seconds

export function startPolling() {
    console.log("Starting MTA background polling service...");

    // Initial fetch
    fetchData();

    // Schedule periodic fetching
    setInterval(fetchData, POLLING_INTERVAL_MS);
}

async function fetchData() {
    try {
        const data = await fetchMTAData();
        // Cache is updated internally in mtaService.ts
        if (process.env.DEBUG) {
            console.log(`[Polling] Fetched ${data.entity?.length || 0} entities`);
        }
    } catch (error) {
        console.error("[Polling] Failed to fetch MTA data:", error);
    }
}
