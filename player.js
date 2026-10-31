// LoRix Player Core Logic - English Standardized
const videoPlayer = document.getElementById('lorixVideoPlayer');
const familyToggle = document.getElementById('familyModeToggle');
const statusBadge = document.getElementById('statusBadge');

let isFamilyModeActive = true;
let activeFilterRules = [];

// 1. Background JSON Filter Loader
async function loadFilterRulesMap(mediaId) {
    try {
        // Simulated structural filter map (Will fetch real JSON file seamlessly)
        activeFilterRules = [
            { start: 6, end: 12, action: "mute" },   // Mutes profanity smoothly
            { start: 22, end: 30, action: "skip" }   // Skips sensitive scene seamlessly
        ];
        console.log("[LoRix Engine] Filter map initialized successfully.");
    } catch (error) {
        console.warn("[LoRix Engine] No filter rules found. Playing raw stream.");
        activeFilterRules = [];
    }
}

// 2. High-Precision Background Time Monitoring Engine
videoPlayer.addEventListener('timeupdate', () => {
    if (!isFamilyModeActive || activeFilterRules.length === 0) return;

    const currentPlaybackTime = videoPlayer.currentTime;

    for (let rule of activeFilterRules) {
        if (currentPlaybackTime >= rule.start && currentPlaybackTime < rule.end) {
            if (rule.action === 'skip') {
                console.log(`[LoRix Protection] Skipping filtered segment to: ${rule.end}s`);
                videoPlayer.currentTime = rule.end;
            } else if (rule.action === 'mute') {
                if (!videoPlayer.muted) {
                    console.log("[LoRix Protection] Muting audio segment");
                    videoPlayer.muted = true;
                }
            }
            break;
        } else if (rule.action === 'mute' && videoPlayer.muted && currentPlaybackTime >= rule.end) {
            console.log("[LoRix Protection] Restoring audio volume");
            videoPlayer.muted = false;
        }
    }
});

// 3. Dynamic Family Mode Switch Toggle Handler
familyToggle.addEventListener('change', (event) => {
    isFamilyModeActive = event.target.checked;
    
    if (isFamilyModeActive) {
        statusBadge.textContent = "ACTIVE";
        statusBadge.style.background = "rgba(139, 92, 246, 0.2)";
        statusBadge.style.color = "#c4b5fd";
        console.log("[LoRix UI] Family Mode enabled.");
    } else {
        statusBadge.textContent = "OFF";
        statusBadge.style.background = "rgba(239, 68, 68, 0.2)";
        statusBadge.style.color = "#fca5a5";
        if (videoPlayer.muted) {
            videoPlayer.muted = false;
        }
        console.log("[LoRix UI] Family Mode disabled. Unfiltered raw playback.");
    }
});

// Initialize LoRix Core on load
loadFilterRulesMap("sample_lorix_media_01");