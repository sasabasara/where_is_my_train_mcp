import { createApp } from "./app.js";
import { startPolling } from "./services/pollingService.js";
import { ensureDataLoaded } from "./services/stationService.js";
import { ensureStationInfoLoaded } from "./services/stationInfoService.js";
import { SERVER_VERSION } from "./version.js";

const { app } = createApp();
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(JSON.stringify({
        event: "server_start",
        timestamp: new Date().toISOString(),
        port: PORT,
        version: SERVER_VERSION,
        node: process.version
    }));

    startPolling();
    ensureStationInfoLoaded();

    ensureDataLoaded().then(() => {
        console.log(JSON.stringify({
            event: "gtfs_loaded",
            timestamp: new Date().toISOString(),
            success: true
        }));
    }).catch(err => {
        console.log(JSON.stringify({
            event: "gtfs_loaded",
            timestamp: new Date().toISOString(),
            success: false,
            error: err.message
        }));
    });
});
