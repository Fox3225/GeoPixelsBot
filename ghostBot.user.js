// ==UserScript==
// @name         GhostPixel Bot
// @namespace    https://github.com/nymtuta
// @version      0.4.1
// @description  A bot to place pixels from the ghost image on https://geopixels.net (with UI & themes)
// @author       nymtuta + assistant
// @match        https://*.geopixels.net/*
// @updateURL    https://github.com/nymtuta/GeoPixelsBot/raw/refs/heads/main/ghostBot.user.js
// @downloadURL  https://github.com/nymtuta/GeoPixelsBot/raw/refs/heads/main/ghostBot.user.js
// @homepage     https://github.com/nymtuta/GeoPixelsBot
// @icon         https://raw.githubusercontent.com/nymtuta/GeoPixelsBot/refs/heads/main/img/icon.png
// @license      GPL-3.0
// @grant        unsafeWindow
// ==/UserScript==

//#region Utils
Number.prototype.iToH = function () {
	return this.toString(16).padStart(2, "0");
};
String.prototype.hToI = function () {
	return parseInt(this, 16);
};

String.prototype.toFullHex = function () {
	let h = this.toLowerCase();
	if (!h.startsWith("#")) h = `#${h}`;
	if (h.length === 4 || h.length === 5) h = "#" + [...h.slice(1)].map((c) => c + c).join("");
	if (h.length === 7) h += "ff";
	return h;
};

class Color {
	constructor(arg = {}) {
		if (typeof arg === "string") return this.constructorFromHex(arg);
		if (typeof arg === "number") return this.constructorFromId(arg);
		this.r = arg.r;
		this.g = arg.g;
		this.b = arg.b;
		this.a = arg.a === undefined || arg.a === null ? 255 : arg.a;
	}

	constructorFromHex(hex) {
		hex = hex.toFullHex();
		var r = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
		if (!r) throw new Error("Invalid hex color: " + hex);
		this.r = r[1].hToI();
		this.g = r[2].hToI();
		this.b = r[3].hToI();
		this.a = r[4].hToI();
	}

	constructorFromId(id) {
		if (id === -1) {
			this.r = this.g = this.b = this.a = 0;
			return;
		}
		this.r = (id >> 16) & 0xff;
		this.g = (id >> 8) & 0xff;
		this.b = id & 0xff;
		this.a = 255;
	}

	rgbaString = () => `rgba(${this.r},${this.g},${this.b},${this.a})`;

	hex = () => "#" + [this.r, this.g, this.b, this.a].map((x) => x.iToH()).join("");

	id = () => (this.a === 0 ? -1 : (this.r << 16) + (this.g << 8) + this.b);
}

const pixelToGridCoord = (i, topLeft, width) => ({
	x: topLeft.x + (i % width),
	y: topLeft.y - Math.floor(i / width),
});

function coordToTileCoord({ x, y }) {
	return {
		x: Math.floor(x / SYNC_TILE_SIZE) * SYNC_TILE_SIZE,
		y: Math.floor(y / SYNC_TILE_SIZE) * SYNC_TILE_SIZE,
	};
}

function getAllCoordsBetween(a, b, size = 1) {
	const coords = [];
	for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x += size)
		for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y += size) coords.push({ x, y });
	return coords;
}

const LOG_LEVELS = {
	error: { label: "ERR", color: "red" },
	info: { label: "INF", color: "lime" },
	warn: { label: "WRN", color: "yellow" },
	debug: { label: "DBG", color: "cyan" },
};

function log(lvl, ...args) {
	console.log(
		`%c[ghostBot] %c[${lvl.label}]`,
		"color: rebeccapurple;",
		`color:${lvl.color};`,
		...args
	);
}

function canvasToImageData(canvasData, x, y, existingMap = new Map()) {
	for (let i = 0; i < canvasData.data.length; i += 4) {
		const gridCoord = pixelToGridCoord(i / 4, { x, y }, canvasData.width);
		const color = new Color({
			r: canvasData.data[i],
			g: canvasData.data[i + 1],
			b: canvasData.data[i + 2],
			a: canvasData.data[i + 3],
		});
		existingMap.set(`${gridCoord.x},${gridCoord.y}`, { gridCoord, color });
	}
	return existingMap;
}

function loadImageAsync(src) {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = reject;
		img.src = src;
	});
}

async function webpToCanvasData(webp, width, height) {
	const img = await loadImageAsync(`data:image/webp;base64,${webp}`);
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	ctx.translate(0, height);
	ctx.scale(1, -1);
	ctx.drawImage(img, 0, 0);
	const canvasData = ctx.getImageData(0, 0, width, height);
	canvas.remove();
	return canvasData;
}
webpToCanvasData = withErrorHandling(webpToCanvasData);

const FREE_COLORS = [
	"#FFFFFF",
	"#FFCA3A",
	"#FF595E",
	"#F3BBC2",
	"#BD637D",
	"#6A4C93",
	"#A8D0DC",
	"#1A535C",
	"#1982C4",
	"#8AC926",
	"#6B4226",
	"#CFD078",
	"#8B1D24",
	"#C49A6C",
	"#000000",
	"#00000000",
].map((c) => new Color(c));

function withErrorHandling(asyncFn) {
	return async function (...args) {
		try {
			return await asyncFn(...args);
		} catch (e) {
			log(LOG_LEVELS.error, e);
		}
	};
}

const SYNC_TILE_SIZE = 1000;
//#endregion

(function () {
	const usw = unsafeWindow;
	let ghostPixelData, ghostData;
	const placedPixelData = new Map();
	let ignoredColors = new Set();
	let lastServerTimestamp = 0;
	const GOOGLE_CLIENT_ID = document.getElementById("g_id_onload")?.getAttribute("data-client_id");

	const tryRelog = withErrorHandling(async function () {
		tokenUser = "";

		if (GOOGLE_CLIENT_ID) {
			log(LOG_LEVELS.info, "attempting relog with google");
			await new Promise((resolve) => {
				google.accounts.id.initialize({
					client_id: GOOGLE_CLIENT_ID,
					callback: async (e) => {
						const r = await fetch("/auth/google", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ token: e.credential }),
						});
						if (!r.ok) return log(LOG_LEVELS.info, "Google authentication failed");
						const data = await r.json();
						await logIn(data);

						resolve();
					},
					auto_select: true,
					context: "signin",
				});

				google.accounts.id.prompt();
			});
		}

		log(LOG_LEVELS.info, `Relog ${tokenUser.length ? "successful" : "failed"}`);
		return !!tokenUser.length;
	});

	function getGhostImageData() {
		if (!ghostImageOriginalData || !ghostImageTopLeft) return null;
		return canvasToImageData(
			ghostImageOriginalData,
			ghostImageTopLeft.gridX,
			ghostImageTopLeft.gridY
		);
	}

	function setGhostPixelData() {
		ghostData = Array.from(getGhostImageData().values());
		const freeColorIds = FREE_COLORS.map((c) => c.id());
		const availableColorIds = Colors.map((c) => new Color(c).id());
		ghostPixelData = ghostData.filter((d) => {
			return (
				(usw.ghostBot.placeTransparentGhostPixels || d.color.a > 0) &&
				(usw.ghostBot.placeFreeColors || !freeColorIds.includes(d.color.id())) &&
				availableColorIds.includes(d.color.id()) &&
				!ignoredColors.has(d.color.id())
			);
		});
	}

	function getGhostPixelData() {
		if (!ghostPixelData) setGhostPixelData();
		return ghostPixelData;
	}

	function getGhostData() {
		if (!ghostData) setGhostPixelData();
		return ghostData;
	}

	const updatePlacedPixels = withErrorHandling(async function () {
		const ghostData = getGhostData();
		const topLeft = ghostData[0].gridCoord;
		const bottomRight = ghostData[ghostData.length - 1].gridCoord;

		const tileCoords = getAllCoordsBetween(topLeft, bottomRight, SYNC_TILE_SIZE);

		async function fetchTiles(tiles) {
			return await fetch(`/GetPixelsCached`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					Tiles: tiles.map((t) => ({ ...t, timestamp: lastServerTimestamp })),
				}),
			});
		}

		for (let i = 0; i < tileCoords.length; i += 9) {
			const r = await (await fetchTiles(tileCoords.slice(i, i + 9))).json();
			if (r.ServerTimestamp) lastServerTimestamp = r.ServerTimestamp;
			for (const [n, tile] of Object.entries(r.Tiles)) {
				const coord = n.split("_").map(Number).filter(Number.isFinite);
				if (tile.Type == "delta" && tile.Pixels.length)
					for (const p of tile.Pixels) {
						const [gridX, gridY, color, userId] = p;
						placedPixelData.set(`${gridX},${gridY}`, {
							gridCoord: { x: gridX, y: gridY },
							color: new Color(color),
						});
					}
				else if (tile.Type == "full") {
					const canvasData = await webpToCanvasData(tile.ColorWebP, SYNC_TILE_SIZE, SYNC_TILE_SIZE);
					canvasToImageData(canvasData, +coord[0], +coord[1] + SYNC_TILE_SIZE - 1, placedPixelData);
				}
			}
		}
	});

	Array.prototype.orderGhostPixels = function () {
		const freqMap = new Map();
		this.forEach((pixel) => {
			const val = pixel.color.id();
			freqMap.set(val, (freqMap.get(val) || 0) + 1);
		});
		return this.sort((a, b) => {
			const aFreq = freqMap.get(a.color.id());
			const bFreq = freqMap.get(b.color.id());
			return aFreq - bFreq;
		});
	};

	const getPixelsToPlace = withErrorHandling(async function () {
		await updatePlacedPixels();

		return getGhostPixelData()
			.orderGhostPixels()
			.filter((d) => {
				const placedPixel = placedPixelData.get(`${d.gridCoord.x},${d.gridCoord.y}`);
				return !placedPixel || placedPixel.color.id() !== d.color.id();
			});
	});

	const sendPixels = withErrorHandling(async function (pixels) {
		const r = await fetch("https://geopixels.net/PlacePixel", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				Token: tokenUser,
				Subject: subject,
				UserId: userID,
				Pixels: pixels.map((c) => ({ ...c, UserId: userID })),
			}),
		});
		if (!r.ok) {
			log(LOG_LEVELS.warn, "Failed to place pixels. : " + (await r.text()));
			if (r.status == 401 && (await tryRelog())) await sendPixels(pixels);
		} else log(LOG_LEVELS.info, `Placed ${pixels.length} pixels!`);
	});

	let stopWhileLoop = false;
	let promiseResolve;

	const startGhostBot = withErrorHandling(async function () {
		if (!ghostImage || !ghostImageOriginalData || !ghostImageTopLeft) {
			log(LOG_LEVELS.warn, "Ghost image not loaded.");
			return;
		}
		stopWhileLoop = false;
		while (!stopWhileLoop) {
			const pixelsToPlace = await getPixelsToPlace();
			if (pixelsToPlace.length === 0) {
				log(LOG_LEVELS.info, "All pixels are correctly placed.");
				break;
			}
			const pixelsThisRequest = pixelsToPlace.slice(0, currentEnergy);
			log(LOG_LEVELS.info, `Placing ${pixelsThisRequest.length}/${pixelsToPlace.length} pixels...`);

			await sendPixels(
				pixelsThisRequest.map((d) => ({
					GridX: d.gridCoord.x,
					GridY: d.gridCoord.y,
					Color: d.color.id(),
				}))
			);

			if (!tokenUser) {
				log(LOG_LEVELS.warn, "logged out => stopping the bot");
				break;
			}
			if (pixelsToPlace.length === pixelsThisRequest.length) {
				log(LOG_LEVELS.info, "All pixels are correctly placed.");
				break;
			}

			await new Promise((resolve) => {
				promiseResolve = resolve;
				setTimeout(
					resolve,
					(maxEnergy > pixelsToPlace.length ? pixelsToPlace.length : maxEnergy - 2) *
						energyRate *
						1000
				);
			});
		}
	});

	usw.ghostBot = {
		placeTransparentGhostPixels: false,
		placeFreeColors: true,
		ignoreColors: withErrorHandling((input, sep = ",") => {
			if (input === undefined) input = [];
			if (!Array.isArray(input)) input = input.split(sep);
			ignoredColors = new Set(input.map((c) => new Color(c).id()));
			log(LOG_LEVELS.info, "New ignored colors :", ignoredColors);
		}),
		start: () => startGhostBot(),
		stop: () => {
			stopWhileLoop = true;
			promiseResolve?.();
			log(LOG_LEVELS.info, "Ghost bot stopped");
		},
		reload: () => {
			setGhostPixelData();
			placedPixelData.clear();
			lastServerTimestamp = 0;
			updatePlacedPixels();
		},
	};

	log(
		LOG_LEVELS.info,
		"GhostPixel Bot loaded. Use ghostBot.start() to start and ghostBot.stop() to stop."
	);

    // ===========================================================
    //        GHOSTBOT CONTROL PANEL UI (UNIFIED) — THEMES EDITION
    // ===========================================================

    const THEMES = {
        dark: {
            background: "rgba(20,20,20,0.92)",
            text: "#fff",
            accent: "#4CAF50",
            border: "#333",
            shadow: "0 0 12px rgba(0,0,0,0.7)"
        },
        light: {
            background: "rgba(255,255,255,0.92)",
            text: "#000",
            accent: "#1976D2",
            border: "#ddd",
            shadow: "0 0 12px rgba(0,0,0,0.3)"
        },
        neon: {
            background: "#000000cc",
            text: "#0AFFEF",
            accent: "#FF00E6",
            border: "#0AFFEF",
            shadow: "0 0 25px #0AFFEF"
        },
        cyberpunk: {
            background: "#0d0221cc",
            text: "#ff2b6e",
            accent: "#05d9e8",
            border: "#ff2b6e",
            shadow: "0 0 20px #ff2b6e"
        }
    };

    // default theme = cyberpunk (as requested)
    let currentTheme = localStorage.getItem("ghostbot_theme") || "cyberpunk";

    // Create panel element
    const panel = document.createElement("div");
    panel.classList.add("ghost-panel");
    panel.style.position = "fixed";
    panel.style.top = "20px";
    panel.style.right = "20px";
    panel.style.padding = "15px";
    panel.style.width = "300px";
    panel.style.borderRadius = "14px";
    panel.style.zIndex = "999999";
    panel.style.userSelect = "none";
    panel.style.fontFamily = "Arial, sans-serif";
    panel.style.transition = "box-shadow 0.15s, transform 0.08s";

    panel.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
            <div style="font-size:18px; font-weight:700;">GhostBot Panel</div>
            <button id="gbMin" title="Minimize" style="border:none;background:transparent;color:inherit;cursor:pointer;font-weight:700;">–</button>
        </div>

        <div id="gbBody">
            <button id="gbStart" class="gbBtn" style="width:100%; padding:8px; border:none; border-radius:8px; margin-bottom:6px;">Start</button>
            <button id="gbStop" class="gbBtn" style="width:100%; padding:8px; border:none; border-radius:8px; margin-bottom:6px;">Stop</button>
            <button id="gbReload" class="gbBtn" style="width:100%; padding:8px; border:none; border-radius:8px; margin-bottom:10px;">Reload Ghost Data</button>

            <label style="font-size:14px; font-weight:600;">Ignore Colors:</label>
            <input id="gbIgnoreInput" type="text"
                placeholder="Ex: #ff0000, #00ff00 or 16711680"
                style="width:100%; padding:7px; border-radius:8px; border:1px solid rgba(0,0,0,0.2); margin-top:6px; margin-bottom:8px; box-sizing:border-box;">

            <div style="display:flex; gap:8px; margin-bottom:10px;">
                <button id="gbIgnoreButton" class="gbBtn" style="flex:1; padding:7px; border:none; border-radius:8px;">Add to Ignored</button>
                <button id="gbClearIgnored" style="flex:1; padding:7px; border-radius:8px; border:1px solid rgba(0,0,0,0.15); background:transparent; cursor:pointer;">Clear Ignored</button>
            </div>

            <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
                <label style="flex:1;"><input type="checkbox" id="gbTransparent"> Place Transparent Pixels</label>
                <label style="flex:1;"><input type="checkbox" id="gbFreeColors" checked> Place Free Colors</label>
            </div>

            <hr style="margin:10px 0; border-color:rgba(0,0,0,0.18);">

            <label style="font-size:14px; font-weight:700;">Theme:</label>
            <select id="gbTheme" style="width:100%; padding:8px; border-radius:8px; margin-top:6px;"></select>

            <div style="margin-top:10px; font-size:12px; color:inherit; opacity:0.9;">
                <div>Status: <span id="gbStatus">idle</span></div>
                <div id="gbIgnoredDisplay" style="margin-top:6px; word-break:break-all;"></div>
            </div>
        </div>
    `;

    document.body.appendChild(panel);

    // Add style fix for option colors (improves visibility across browsers)
    const styleFix = document.createElement("style");
    styleFix.textContent = `
        /* Ensure select options are readable across themes and browsers */
        .ghost-panel select option {
            background: rgba(0,0,0,0.9) !important;
            color: #ffffff !important;
        }
        .ghost-panel.light select option {
            background: #ffffff !important;
            color: #000000 !important;
        }
        .ghost-panel.cyberpunk select option {
            background: #0d0221 !important;
            color: #ff2b6e !important;
        }
        .ghost-panel.neon select option {
            background: #000000 !important;
            color: #0AFFEF !important;
        }
        /* Make the select itself inherit theme text color */
        .ghost-panel select, .ghost-panel input { color: inherit !important; }
    `;
    document.head.appendChild(styleFix);

    // Populate theme selector
    const themeSelect = panel.querySelector("#gbTheme");
    Object.keys(THEMES).forEach(t => {
        const option = document.createElement("option");
        option.value = t;
        option.innerText = t.toUpperCase();
        themeSelect.appendChild(option);
    });

    // Helpers for ignored display
    function updateIgnoredDisplay() {
        const disp = panel.querySelector("#gbIgnoredDisplay");
        if (!ignoredColors || ignoredColors.size === 0) {
            disp.textContent = "Ignored: (none)";
        } else {
            disp.textContent = "Ignored: " + Array.from(ignoredColors).map(id => {
                try { return "#" + new Color(id).hex().slice(1,7); } catch(e){ return String(id); }
            }).join(", ");
        }
    }

    // Apply theme function
    function applyTheme(themeName) {
        const theme = THEMES[themeName] || THEMES.dark;
        currentTheme = themeName;
        try { localStorage.setItem("ghostbot_theme", themeName); } catch (e) {}
        panel.style.background = theme.background;
        panel.style.color = theme.text;
        panel.style.boxShadow = theme.shadow;
        panel.style.border = `1px solid ${theme.border}`;

        // style inputs and buttons
        panel.querySelectorAll(".gbBtn").forEach(btn => {
            btn.style.background = theme.accent;
            btn.style.color = "#ffffff";
            btn.style.boxShadow = "none";
        });

        // style text inputs background/foreground for readability
        panel.querySelectorAll("input[type=text], select").forEach(el => {
            // invert backgrounds for light theme
            if (themeName === "light") {
                el.style.background = "#fff";
                el.style.color = "#000";
                el.style.border = "1px solid #ddd";
            } else {
                el.style.background = "rgba(255,255,255,0.06)";
                el.style.color = theme.text;
                el.style.border = "1px solid rgba(255,255,255,0.06)";
            }
        });

        // set a panel theme-specific class so option CSS applies
        panel.className = "ghost-panel " + themeName;

        themeSelect.value = themeName;
    }

    // Hook up buttons
    const btnStart = panel.querySelector("#gbStart");
    const btnStop = panel.querySelector("#gbStop");
    const btnReload = panel.querySelector("#gbReload");
    const inputIgnore = panel.querySelector("#gbIgnoreInput");
    const btnIgnore = panel.querySelector("#gbIgnoreButton");
    const btnClearIgnored = panel.querySelector("#gbClearIgnored");
    const chkTransparent = panel.querySelector("#gbTransparent");
    const chkFreeColors = panel.querySelector("#gbFreeColors");
    const statusEl = panel.querySelector("#gbStatus");
    const minBtn = panel.querySelector("#gbMin");
    const gbBody = panel.querySelector("#gbBody");

    // Minimize toggle
    let minimized = false;
    minBtn.onclick = () => {
        minimized = !minimized;
        gbBody.style.display = minimized ? "none" : "block";
        minBtn.textContent = minimized ? "+" : "–";
        panel.style.width = minimized ? "120px" : "300px";
    };

    // Start/Stop/Reload
    btnStart.onclick = () => {
        try {
            usw.ghostBot.start();
            statusEl.textContent = "running";
            flashPanel();
        } catch (e) {
            console.error(e);
            alert("Erro ao iniciar ghostBot: " + e);
        }
    };
    btnStop.onclick = () => {
        try {
            usw.ghostBot.stop();
            statusEl.textContent = "stopped";
            flashPanel();
        } catch (e) {
            console.error(e);
            alert("Erro ao parar ghostBot: " + e);
        }
    };
    btnReload.onclick = () => {
        try {
            usw.ghostBot.reload();
            statusEl.textContent = "reloaded";
            flashPanel();
            setTimeout(() => statusEl.textContent = "idle", 1200);
        } catch (e) {
            console.error(e);
            alert("Erro ao recarregar: " + e);
        }
    };

    // Ignore colors - accepts comma separated hex or numbers or array-like string
    function parseIgnoreInput(text) {
        // remove brackets if user pasted array-like input
        text = text.trim();
        if (!text) return [];
        if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
        // split by comma or whitespace
        const parts = text.split(/[,]+/).map(s => s.trim()).filter(Boolean);
        const res = [];
        for (const p of parts) {
            // try hex
            try {
                if (p.startsWith("#") || /^[0-9a-fA-F]{6,8}$/.test(p)) {
                    res.push(new Color(p).id());
                    continue;
                }
                // numeric id?
                const n = Number(p);
                if (!Number.isNaN(n)) {
                    res.push(n);
                    continue;
                }
                // named color? try to parse via temporary element
                const tmp = document.createElement("div");
                tmp.style.color = p;
                document.body.appendChild(tmp);
                const cs = getComputedStyle(tmp).color;
                document.body.removeChild(tmp);
                if (cs && cs.startsWith("rgb")) {
                    const nums = cs.match(/\d+/g).map(Number);
                    const c = new Color({ r: nums[0], g: nums[1], b: nums[2], a: 255 });
                    res.push(c.id());
                    continue;
                }
            } catch (e) {
                // ignore invalid token
            }
        }
        return res;
    }

    btnIgnore.onclick = () => {
        const text = inputIgnore.value.trim();
        if (!text) return;
        const ids = parseIgnoreInput(text);
        if (!ids.length) {
            alert("Nenhuma cor válida encontrada no input.");
            return;
        }
        // call ghostBot.ignoreColors with array
        try {
            usw.ghostBot.ignoreColors(ids);
            // update local ignoredColors set (the bot also updates it internally)
            ids.forEach(id => ignoredColors.add(id));
            updateIgnoredDisplay();
            inputIgnore.value = "";
            flashPanel();
        } catch (e) {
            console.error(e);
            alert("Erro ao adicionar cores ignoradas: " + e);
        }
    };

    btnClearIgnored.onclick = () => {
        ignoredColors.clear();
        try {
            // call with empty array to clear
            usw.ghostBot.ignoreColors([]);
        } catch (e) {
            console.warn("ghostBot.ignoreColors may not support clearing via []", e);
        }
        updateIgnoredDisplay();
        flashPanel();
    };

    chkTransparent.onchange = (e) => {
        try {
            usw.ghostBot.placeTransparentGhostPixels = e.target.checked;
        } catch (err) {
            console.warn(err);
        }
    };
    chkFreeColors.onchange = (e) => {
        try {
            usw.ghostBot.placeFreeColors = e.target.checked;
        } catch (err) {
            console.warn(err);
        }
    };

    // Theme selector
    themeSelect.onchange = () => {
        applyTheme(themeSelect.value);
    };

    // Make panel draggable
    let drag = false, dx = 0, dy = 0;
    panel.addEventListener("mousedown", e => {
        // only start drag if clicking header area or panel background (not inputs)
        const tag = e.target.tagName.toLowerCase();
        if (tag === "input" || tag === "select" || tag === "button" || e.target.closest("input") || e.target.closest("select")) return;
        drag = true;
        dx = e.clientX - panel.offsetLeft;
        dy = e.clientY - panel.offsetTop;
        panel.style.cursor = "grabbing";
    });
    document.addEventListener("mouseup", () => { drag = false; panel.style.cursor = "default"; });
    document.addEventListener("mousemove", e => {
        if (!drag) return;
        panel.style.left = `${e.clientX - dx}px`;
        panel.style.top = `${e.clientY - dy}px`;
        panel.style.right = "auto";
    });

    // Small visual pulse when actions happen
    function flashPanel() {
        panel.style.transform = "scale(0.995)";
        setTimeout(() => panel.style.transform = "scale(1)", 80);
    }

    // Initialize UI values from ghostBot defaults (if present)
    try {
        chkTransparent.checked = !!(usw.ghostBot && usw.ghostBot.placeTransparentGhostPixels);
        chkFreeColors.checked = (usw.ghostBot && typeof usw.ghostBot.placeFreeColors !== "undefined") ? !!usw.ghostBot.placeFreeColors : true;
    } catch (e) {}

    // If the bot already has an ignoredColors set we try to mirror it
    try {
        // we only have access to the local ignoredColors var in this script; keep it in sync when ghostBot.ignoreColors called
        // updateIgnoredDisplay will show our local set
        updateIgnoredDisplay();
    } catch (e) {}

    // Populate theme/local settings and apply
    applyTheme(currentTheme);

    // Expose a small helper in page to programmatically open/close UI
    usw.ghostBotUI = {
        show: () => panel.style.display = "block",
        hide: () => panel.style.display = "none",
        toggle: () => panel.style.display = (panel.style.display === "none" ? "block" : "none"),
        setTheme: (t) => { if (THEMES[t]) applyTheme(t); }
    };

    // ensure status initial
    statusEl.textContent = "idle";
    updateIgnoredDisplay();

    // end of IIFE
})();
