// ==UserScript==
// @name         SponsorBlock Lite
// @namespace    https://sponsor.ajay.app
// @version      1.0.0
// @description  Auto-skip sponsor segments on YouTube using SponsorBlock API
// @author       SponsorBlock
// @match        https://www.youtube.com/*
// @match        https://music.youtube.com/*
// @icon         https://sponsor.ajay.app/LogoSponsorBlock256px.png
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @connect      sponsor.ajay.app
// @run-at       document-idle
// @license      LGPL-3.0-or-later
// @downloadURL  https://raw.githubusercontent.com/hxueh/SponsorBlock/refs/heads/master/sponsorblock.user.js
// @updateURL    https://raw.githubusercontent.com/hxueh/SponsorBlock/refs/heads/master/sponsorblock.user.js
// ==/UserScript==

(function () {
    "use strict";

    // ==================== CONSTANTS ====================

    const API_BASE = "https://sponsor.ajay.app";
    const CATEGORIES = [
        "sponsor",
        "selfpromo",
        "exclusive_access",
        "interaction",
        "outro",
        "music_offtopic",
    ];
    const ACTION_TYPES = ["skip", "full"];
    const SKIP_BUFFER = 0.003;

    // Colors for all categories (used in preview bar and category pill)
    const CATEGORY_COLORS = {
        sponsor: "#00d400",
        selfpromo: "#ffff00",
        exclusive_access: "#008a5c",
        interaction: "#cc00ff",
        outro: "#0202ed",
        music_offtopic: "#ff9900",
    };

    const CATEGORY_LABELS = {
        exclusive_access: "Exclusive Access",
    };

    // ==================== STATE ====================

    let currentVideoID = null;
    let segments = [];
    let skippableSegments = [];
    let skipScheduleTimer = null;
    let video = null;
    let lastSkippedUUID = null;
    let currentSegmentIndex = 0;
    let videoChangeDebounce = null;
    let previewBarContainer = null;
    let videoDuration = 0;

    const IS_MUSIC_YOUTUBE = window.location.hostname === "music.youtube.com";

    // ==================== CSS INJECTION ====================

    function injectStyles() {
        const css = `
            #sb-lite-previewbar {
                position: absolute;
                width: 100%;
                height: 100%;
                padding: 0;
                margin: 0;
                overflow: visible;
                pointer-events: none;
                z-index: 42;
                list-style: none;
                transform: scaleY(0.6);
                transition: transform 0.1s cubic-bezier(0, 0, 0.2, 1);
            }

            /* Expand on hover */
            .ytp-progress-bar:hover #sb-lite-previewbar {
                transform: scaleY(1);
            }

            /* Fullscreen mode */
            .ytp-big-mode #sb-lite-previewbar {
                transform: scaleY(0.625);
            }

            .ytp-big-mode .ytp-progress-bar:hover #sb-lite-previewbar {
                transform: scaleY(1);
            }

            .sb-lite-segment {
                position: absolute;
                height: 100%;
                min-width: 1px;
                display: inline-block;
                opacity: 0.7;
            }

            .sb-lite-segment:hover {
                opacity: 1;
            }

            #sb-lite-category-pill {
                display: none;
                align-items: center;
                padding: 4px 12px;
                border-radius: 4px;
                font-size: 12px;
                font-weight: 500;
                margin-left: 8px;
                color: white;
                font-family: Roboto, Arial, sans-serif;
                white-space: nowrap;
                cursor: default;
                user-select: none;
            }
        `;

        if (typeof GM_addStyle !== "undefined") {
            GM_addStyle(css);
        } else {
            const style = document.createElement("style");
            style.textContent = css;
            document.head.appendChild(style);
        }
    }

    // ==================== UTILITY FUNCTIONS ====================

    async function sha256(message) {
        const msgBuffer = new TextEncoder().encode(message);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    }

    async function getHashPrefix(videoID) {
        const hash = await sha256(videoID);
        return hash.slice(0, 4);
    }

    function getVideoID() {
        const url = new URL(window.location.href);

        const vParam = url.searchParams.get("v");
        if (vParam && /^[a-zA-Z0-9_-]{11}$/.test(vParam)) {
            return vParam;
        }

        const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
        if (shortsMatch) return shortsMatch[1];

        const embedMatch = url.pathname.match(/\/embed\/([a-zA-Z0-9_-]{11})/);
        if (embedMatch) return embedMatch[1];

        const liveMatch = url.pathname.match(/\/live\/([a-zA-Z0-9_-]{11})/);
        if (liveMatch) return liveMatch[1];

        return null;
    }

    function getVideoDuration() {
        return video?.duration || 0;
    }

    // ==================== API FUNCTIONS ====================

    function fetchSegments(videoID) {
        return new Promise(async (resolve) => {
            try {
                const hashPrefix = await getHashPrefix(videoID);
                const params = new URLSearchParams({
                    categories: JSON.stringify(CATEGORIES),
                    actionTypes: JSON.stringify(ACTION_TYPES),
                });

                GM_xmlhttpRequest({
                    method: "GET",
                    url: `${API_BASE}/api/skipSegments/${hashPrefix}?${params}`,
                    headers: { Accept: "application/json" },
                    onload(response) {
                        if (response.status === 200) {
                            try {
                                const data = JSON.parse(response.responseText);
                                const videoData = data.find(
                                    (v) => v.videoID === videoID,
                                );
                                const segs = videoData?.segments || [];
                                segs.sort(
                                    (a, b) => a.segment[0] - b.segment[0],
                                );
                                resolve(segs);
                            } catch {
                                resolve([]);
                            }
                        } else {
                            resolve([]);
                        }
                    },
                    onerror() {
                        resolve([]);
                    },
                });
            } catch {
                resolve([]);
            }
        });
    }

    // ==================== SKIP LOGIC ====================

    function computeSkippableSegments() {
        skippableSegments = segments.filter((s) => {
            if (s.actionType === "full") return false;
            if (s.category === "music_offtopic" && !IS_MUSIC_YOUTUBE)
                return false;
            return true;
        });
        currentSegmentIndex = 0;
    }

    function skipToTime(targetTime) {
        if (video && targetTime !== undefined) {
            video.currentTime = targetTime;
        }
    }

    function findNextSegment(currentTime) {
        if (
            currentSegmentIndex > 0 &&
            skippableSegments[currentSegmentIndex - 1] &&
            currentTime < skippableSegments[currentSegmentIndex - 1].segment[0]
        ) {
            currentSegmentIndex = 0;
        }

        while (currentSegmentIndex < skippableSegments.length) {
            const seg = skippableSegments[currentSegmentIndex];
            if (currentTime < seg.segment[1] - SKIP_BUFFER) {
                return { segment: seg, index: currentSegmentIndex };
            }
            currentSegmentIndex++;
        }
        return null;
    }

    function scheduleSkips() {
        if (skipScheduleTimer) {
            clearTimeout(skipScheduleTimer);
            skipScheduleTimer = null;
        }

        if (!video || video.paused || !skippableSegments.length) return;

        const currentTime = video.currentTime;
        const result = findNextSegment(currentTime);

        if (!result) return;

        const { segment: nextSegment } = result;
        const [startTime, endTime] = nextSegment.segment;

        if (currentTime >= startTime - SKIP_BUFFER) {
            if (lastSkippedUUID !== nextSegment.UUID) {
                lastSkippedUUID = nextSegment.UUID;
                skipToTime(endTime);
                currentSegmentIndex++;
            }
            setTimeout(scheduleSkips, 50);
            return;
        }

        const timeUntilStart = (startTime - currentTime) / video.playbackRate;
        const delayMs = Math.max(0, timeUntilStart * 1000 - 50);

        skipScheduleTimer = setTimeout(() => {
            if (!video || video.paused) return;

            const nowTime = video.currentTime;
            if (
                nowTime >= startTime - SKIP_BUFFER &&
                nowTime < endTime - SKIP_BUFFER
            ) {
                if (lastSkippedUUID !== nextSegment.UUID) {
                    lastSkippedUUID = nextSegment.UUID;
                    skipToTime(endTime);
                    currentSegmentIndex++;
                }
            }
            scheduleSkips();
        }, delayMs);
    }

    // ==================== PREVIEW BAR ====================

    function createPreviewBar() {
        const container = document.createElement("ul");
        container.id = "sb-lite-previewbar";
        return container;
    }

    function createSegmentBar(segment, duration) {
        const bar = document.createElement("li");
        bar.className = "sb-lite-segment";

        const startTime = segment.segment[0];
        const endTime = Math.min(segment.segment[1], duration);

        const startPercent = (startTime / duration) * 100;
        const endPercent = (endTime / duration) * 100;

        bar.style.left = `${startPercent}%`;
        bar.style.right = `${100 - endPercent}%`;
        bar.style.backgroundColor = CATEGORY_COLORS[segment.category] || "#888";

        // Add title tooltip
        bar.title = segment.category.replace(/_/g, " ");

        return bar;
    }

    function getProgressBar() {
        // Desktop YouTube
        let progressBar = document.querySelector(".ytp-progress-bar");

        // YouTube Music
        if (!progressBar && IS_MUSIC_YOUTUBE) {
            progressBar = document.querySelector("#progress-bar");
        }

        return progressBar;
    }

    function clearPreviewBar() {
        if (previewBarContainer) {
            previewBarContainer.innerHTML = "";
        }
    }

    function removePreviewBar() {
        if (previewBarContainer) {
            previewBarContainer.remove();
            previewBarContainer = null;
        }
    }

    function updatePreviewBar() {
        const duration = getVideoDuration();
        if (!duration || duration <= 0) return;

        videoDuration = duration;

        // Get or create container
        if (!previewBarContainer) {
            previewBarContainer = createPreviewBar();
        }

        // Attach to progress bar if not already attached
        const progressBar = getProgressBar();
        if (progressBar && !progressBar.contains(previewBarContainer)) {
            progressBar.appendChild(previewBarContainer);
        }

        if (!progressBar) return;

        // Clear existing bars
        clearPreviewBar();

        // Filter segments for preview bar (exclude ActionType.Full)
        const previewSegments = segments.filter((s) => s.actionType !== "full");

        // Sort by duration (longer first) to render properly
        const sortedSegments = [...previewSegments].sort(
            (a, b) =>
                b.segment[1] - b.segment[0] - (a.segment[1] - a.segment[0]),
        );

        // Create segment bars
        for (const segment of sortedSegments) {
            // Skip music_offtopic on non-music YouTube
            if (segment.category === "music_offtopic" && !IS_MUSIC_YOUTUBE) {
                continue;
            }

            const bar = createSegmentBar(segment, duration);
            previewBarContainer.appendChild(bar);
        }
    }

    // ==================== CATEGORY PILL ====================

    function createCategoryPill() {
        const pill = document.createElement("span");
        pill.id = "sb-lite-category-pill";
        return pill;
    }

    function attachCategoryPill() {
        let pill = document.getElementById("sb-lite-category-pill");
        if (!pill) {
            pill = createCategoryPill();
        }

        let titleContainer = null;
        if (IS_MUSIC_YOUTUBE) {
            titleContainer = document.querySelector(
                "ytmusic-player-bar .title",
            );
        } else {
            titleContainer =
                document.querySelector("#above-the-fold #title h1") ||
                document.querySelector("ytd-watch-metadata #title h1") ||
                document.querySelector("#info-contents h1") ||
                document.querySelector("h1.ytd-video-primary-info-renderer");
        }

        if (titleContainer && !titleContainer.contains(pill)) {
            titleContainer.style.display = "flex";
            titleContainer.style.alignItems = "center";
            titleContainer.style.flexWrap = "wrap";
            titleContainer.appendChild(pill);
        }

        return pill;
    }

    function showCategoryPill(segment) {
        const pill = attachCategoryPill();
        if (!pill) return;

        const label = CATEGORY_LABELS[segment.category] || segment.category;
        const color = CATEGORY_COLORS[segment.category] || "#008a5c";

        pill.textContent = label;
        pill.style.backgroundColor = color;
        pill.style.display = "inline-flex";
    }

    function hideCategoryPill() {
        const pill = document.getElementById("sb-lite-category-pill");
        if (pill) {
            pill.style.display = "none";
        }
    }

    function updateCategoryPill() {
        const fullVideoSegment = segments.find((s) => s.actionType === "full");
        if (fullVideoSegment) {
            showCategoryPill(fullVideoSegment);
        } else {
            hideCategoryPill();
        }
    }

    // ==================== VIDEO LISTENERS ====================

    function setupVideoListeners() {
        if (!video) return;

        const videoId = video.getAttribute("data-sb-lite-initialized");
        if (videoId === currentVideoID) return;
        video.setAttribute("data-sb-lite-initialized", currentVideoID);

        video.addEventListener("play", scheduleSkips);
        video.addEventListener("playing", scheduleSkips);

        video.addEventListener("seeked", () => {
            lastSkippedUUID = null;
            currentSegmentIndex = 0;
            if (!video.paused) {
                scheduleSkips();
            }
        });

        video.addEventListener("ratechange", scheduleSkips);

        video.addEventListener("pause", () => {
            if (skipScheduleTimer) {
                clearTimeout(skipScheduleTimer);
                skipScheduleTimer = null;
            }
        });

        // Update preview bar when duration becomes available
        video.addEventListener("durationchange", () => {
            if (segments.length > 0) {
                updatePreviewBar();
            }
        });

        video.addEventListener("loadedmetadata", () => {
            if (segments.length > 0) {
                updatePreviewBar();
            }
        });
    }

    function findVideoElement() {
        video =
            document.querySelector("video.html5-main-video") ||
            document.querySelector("video.video-stream") ||
            document.querySelector("#movie_player video") ||
            document.querySelector("video");
        return video;
    }

    // ==================== NAVIGATION & INITIALIZATION ====================

    function resetState() {
        currentVideoID = null;
        segments = [];
        skippableSegments = [];
        lastSkippedUUID = null;
        currentSegmentIndex = 0;
        videoDuration = 0;

        if (skipScheduleTimer) {
            clearTimeout(skipScheduleTimer);
            skipScheduleTimer = null;
        }

        hideCategoryPill();
        removePreviewBar();
    }

    async function loadSegmentsAndSetup() {
        if (!currentVideoID) return;

        try {
            segments = await fetchSegments(currentVideoID);

            if (segments.length > 0) {
                console.log(
                    `[SB Lite] Found ${segments.length} segments for video ${currentVideoID}`,
                );
            }

            computeSkippableSegments();
            updateCategoryPill();
            updatePreviewBar();
            setupVideoListeners();

            if (video && !video.paused) {
                scheduleSkips();
            }
        } catch (error) {
            console.error("[SB Lite] Failed to load segments:", error);
        }
    }

    function handleVideoChangeImpl() {
        const newVideoID = getVideoID();

        if (!newVideoID || newVideoID === currentVideoID) {
            return;
        }

        resetState();
        currentVideoID = newVideoID;

        let attempts = 0;
        const maxAttempts = 50;

        const checkVideo = setInterval(() => {
            attempts++;
            if (findVideoElement()) {
                clearInterval(checkVideo);
                loadSegmentsAndSetup();
            } else if (attempts >= maxAttempts) {
                clearInterval(checkVideo);
            }
        }, 100);
    }

    function handleVideoChange() {
        if (videoChangeDebounce) {
            clearTimeout(videoChangeDebounce);
        }
        videoChangeDebounce = setTimeout(handleVideoChangeImpl, 50);
    }

    function setupNavigationListener() {
        document.addEventListener("yt-navigate-finish", handleVideoChange);

        document.addEventListener("yt-navigate-start", () => {
            hideCategoryPill();
            removePreviewBar();
        });

        const originalPushState = history.pushState;
        history.pushState = function (...args) {
            originalPushState.apply(this, args);
            handleVideoChange();
        };

        const originalReplaceState = history.replaceState;
        history.replaceState = function (...args) {
            originalReplaceState.apply(this, args);
            handleVideoChange();
        };

        window.addEventListener("popstate", handleVideoChange);
    }

    function init() {
        console.log("[SB Lite] Initializing SponsorBlock Lite");

        injectStyles();
        setupNavigationListener();
        handleVideoChange();

        setTimeout(handleVideoChange, 1000);
    }

    // ==================== START ====================

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
