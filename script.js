////////////////
// PARAMETERS //
////////////////

const queryString = window.location.search;
const urlParams = new URLSearchParams(queryString);

// URL params (fallbacks bevares som før)
const obsServerAddress = urlParams.get("address") || urlParams.get("host") || "127.0.0.1";
const obsServerPort     = urlParams.get("port") || "4455";
const obsServerPassword = urlParams.get("password") || "";
const obsMicInput       = urlParams.get("audio") || "";
const background        = urlParams.get("background") || "";

// UI refs (bruges mange steder)
const $main            = document.getElementById("mainContainer");
const $status          = document.getElementById("statusContainer");
const $recordingRing   = document.getElementById("recordingRing");
const $pauseOverlay    = document.getElementById("pauseOverlay");
const $recordInfo      = document.getElementById("recordInfo");
const $recordLabel     = document.getElementById("recordingLabel");
const $recordTime      = document.getElementById("recordTimecodeLabel");
const $recordSize      = document.getElementById("recordOutputFilesize");
const $streamRing      = document.getElementById("streamingRing");
const $streamInfo      = document.getElementById("streamInfo");
const $streamBitrate   = document.getElementById("streamBitrateLabel");
const $streamTimecode  = document.getElementById("streamTimecodeLabel");
const $streamPlatform  = document.getElementById("streamPlatformLabel");
const $profileLabel    = document.getElementById("profileLabel");
const $statsLabel      = document.getElementById("statsLabel");
const $advStatsLabel   = document.getElementById("advancedStatsLabel");
const $fpsEl           = document.getElementById("fps");
const $fpsMeter        = document.getElementById("fpsMeter");
const $volWrap         = document.getElementById("theMotherOfAllVolumeContainers");
const $volL            = document.getElementById("theGreenShitThatsInsideTheOtherContainerLeft");
const $volR            = document.getElementById("theGreenShitThatsInsideTheOtherContainerRight");
const $micMuteIcon     = document.getElementById("micMuteIcon");

if (obsMicInput !== "") $volWrap.style.visibility = "visible";
if (background !== "")  document.body.style.backgroundImage = `url("frames/${background}.png")`;

let ws = new WebSocket(`ws://${obsServerAddress}:${obsServerPort}/`);

let previousOutputTimecode = 0;
let previousOutputBytes = 0;
let activeFps;

//////////////////////
// CONNECT / RE-TRY //
//////////////////////

function connectws() {
  if (!("WebSocket" in window)) return;

  ws = new WebSocket(`ws://${obsServerAddress}:${obsServerPort}/`);

  ws.onclose = function () {
    SetConnectionStatus(false);
    setTimeout(connectws, 5000);
  };

  ws.onopen = async function () {
    // venter på Hello (op 0)
  };

  ws.onmessage = async function (event) {
    const data = JSON.parse(event.data);

    switch (data.op) {
      case 0: { // Hello
        const salt      = data.d.authentication ? data.d.authentication.salt : "";
        const challenge = data.d.authentication ? data.d.authentication.challenge : "";

        const secretHex = await sha256(obsServerPassword + salt);
        const secretB64 = hexToBase64(secretHex);
        const authHex   = await sha256(secretB64 + challenge);
        const authB64   = hexToBase64(authHex);

        // Abonner på både InputVolumeMeters OG Output events (Record/Stream state)
        const SUB_INPUT_VOLUME = 1 << 16;
        const SUB_OUTPUTS      = 1 << 7;

        ws.send(JSON.stringify({
          op: 1, // Identify
          d: {
            rpcVersion: 1,
            authentication: authB64,
            eventSubscriptions: SUB_INPUT_VOLUME | SUB_OUTPUTS
          }
        }));
        break;
      }

      case 2: { // Identified
        console.log("Connected to OBS!");
        SetConnectionStatus(true);
        break;
      }

      case 3: { // Reidentify (unused here)
        break;
      }

      case 5: { // Event
        const type = data.d.eventType;
        const ev   = data.d.eventData;

        switch (type) {
          case "InputVolumeMeters":
            if (!obsMicInput) break;
            ev.inputs.forEach((input) => {
              if (input.inputName === obsMicInput) {
                if (input.inputLevelsMul.length === 0) {
                  $volWrap.style.visibility = "hidden";
                } else {
                  // L/R meters
                  let tl = new TimelineMax();
                  tl.to($volL, 0.1, { height: (100 * input.inputLevelsMul[0][1]) + "%", ease: Linear.easeNone });
                  tl = new TimelineMax();
                  tl.to($volR, 0.1, { height: (100 * input.inputLevelsMul[1][1]) + "%", ease: Linear.easeNone });
                  $volWrap.style.visibility = "visible";
                }
              }
            });
            break;

          case "RecordStateChanged":
            // Reager live på Recording / Paused / Stopped
            // eventData.outputState: "Recording" | "Paused" | "Stopped"
            applyRecordStateFromEvent(ev.outputState);
            break;

          case "StreamStateChanged":
            // Kan udvides hvis du vil reagere live på stream state
            break;
        }
        break;
      }

      case 7: { // RequestResponse (polling svar)
        switch (data.d.requestType) {

          case "GetStats": {
            const r = data.d.responseData;
            activeFps = `${r.activeFps.toFixed(1)}`;
            const cpu = `${r.cpuUsage.toFixed(1)}%`;
            const memory = `${r.memoryUsage.toFixed(1)}MB`;
            const avgRender = `${r.averageFrameRenderTime.toFixed(1)}ms`;

            const outSkipped = r.outputSkippedFrames;
            const outTotal   = r.outputTotalFrames;
            const outPerc    = outTotal > 0 ? `${(100 * outSkipped / outTotal).toFixed(1)}%` : `0%`;

            const renSkipped = r.renderSkippedFrames;
            const renTotal   = r.renderTotalFrames;
            const renPerc    = `${(100 * renSkipped / renTotal).toFixed(1)}%`;

            $statsLabel.innerHTML = `CPU: ${cpu} • MEM: ${memory} • RENDER TIME: ${avgRender}`;
            $advStatsLabel.innerHTML = `MISSED FRAMES ${outPerc} • SKIPPED FRAMES ${renPerc}`;
            $fpsEl.innerHTML = `${activeFps}`;

            GetVideoSettings();
            break;
          }

          case "GetVideoSettings": {
            const r = data.d.responseData;
            const fps = r.fpsNumerator / r.fpsDenominator;
            const val = (parseFloat(activeFps || "0") / fps);

            let tl = new TimelineMax();
            tl.to($fpsMeter, 0.1, { height: (100 * val) + "%", ease: Linear.easeNone });

            if (val >= 1)        $fpsMeter.style.backgroundColor = `#37d247`;
            else if (val > 0.9)  $fpsMeter.style.backgroundColor = `#e5af24`;
            else                 $fpsMeter.style.backgroundColor = `#D12025`;
            break;
          }

          case "GetRecordStatus": {
            const r = data.d.responseData;
            // v5 svarer med: outputActive (bool), outputPaused (bool), outputTimecode, outputBytes...
            applyRecordStateFromPolling(r);
            break;
          }

          case "GetStreamStatus": {
            const r = data.d.responseData;

            if (!r.outputActive) {
              $streamRing.style.visibility = "hidden";
              $streamInfo.style.visibility = "hidden";
            } else {
              const outputTimecodeMs = TimeToMilliseconds(r.outputTimecode);
              const outputBytes      = r.outputBytes;
              const kbps = ((outputBytes - previousOutputBytes) / (outputTimecodeMs - previousOutputTimecode) * 8);

              previousOutputTimecode = outputTimecodeMs;
              previousOutputBytes    = outputBytes;

              $streamBitrate.innerHTML  = `${Math.floor(kbps)} kb/s`;
              $streamTimecode.innerHTML = `${RemoveMilliseconds(r.outputTimecode)}`;
              GetStreamServiceSettings();

              $streamRing.style.visibility = "visible";
              $streamInfo.style.visibility = "visible";
            }
            break;
          }

          case "GetStreamServiceSettings": {
            const r = data.d.responseData;
            switch (r.streamServiceSettings?.service) {
              case "Twitch":  $streamPlatform.innerHTML = "🟣 Twitch"; break;
              case "YouTube": $streamPlatform.innerHTML = "🔴 YouTube"; break;
              case undefined: $streamPlatform.innerHTML = "🔴 LIVE"; break;
              default:        $streamPlatform.innerHTML = `🔴 ${r.streamServiceSettings.service}`; break;
            }
            break;
          }

          case "GetProfileList": {
            const r = data.d.responseData;
            $profileLabel.innerHTML = `Profile: ${r.currentProfileName}`;
            break;
          }

          case "GetInputMute": {
            const r = data.d.responseData;
            if ($micMuteIcon) {
              $micMuteIcon.style.visibility = r.inputMuted ? "visible" : "hidden";
            }
            break;
          }
        }
        break;
      }
    }
  };
}

/////////////////////////////
// RECORD STATE → UI LOGIK //
/////////////////////////////

function applyRecordStateFromEvent(outputState) {
  // outputState: "Recording" | "Paused" | "Stopped"
  if (outputState === "Recording") {
    showRecordingUI({active: true, paused: false});
  } else if (outputState === "Paused") {
    showRecordingUI({active: true, paused: true});
  } else {
    showRecordingUI({active: false, paused: false});
  }
}

function applyRecordStateFromPolling(r) {
  // r.outputActive (bool), r.outputPaused (bool), r.outputTimecode, r.outputBytes
  if (!r.outputActive) {
    showRecordingUI({active: false, paused: false});
    $recordLabel.innerHTML = ``;
    $recordTime.innerHTML  = ``;
    $recordSize.innerHTML  = ``;
  } else {
    showRecordingUI({active: true, paused: !!r.outputPaused});
    $recordLabel.innerHTML = r.outputPaused ? `PAUSED ⏸` : `REC 🔴`;
    $recordTime.innerHTML  = `${RemoveMilliseconds(r.outputTimecode)}`;
    $recordSize.innerHTML  = `${ConvertToMegabytes(r.outputBytes)}MB`;
  }
}

function showRecordingUI({active, paused}) {
  if (!$recordingRing || !$recordInfo) return;

  if (!active) {
    // Stoppet
    $recordingRing.classList.remove("paused");
    $recordingRing.style.visibility = "hidden";
    $recordInfo.style.visibility    = "hidden";
    if ($pauseOverlay) $pauseOverlay.style.display = "none";
    return;
  }

  // Aktiv optagelse
  $recordingRing.style.visibility = "visible";
  $recordInfo.style.visibility    = "visible";

  if (paused) {
    $recordingRing.classList.add("paused");    // ← CSS får ringen til at blinke
    if ($pauseOverlay) $pauseOverlay.style.display = "block"; // ⏸ i midten
  } else {
    $recordingRing.classList.remove("paused");
    if ($pauseOverlay) $pauseOverlay.style.display = "none";
  }
}

//////////////////////
// HELPER FUNCTIONS //
//////////////////////

function obswsSendRequest(ws, data) {
  ws.send(JSON.stringify({ op: 6, d: data }));
}

function TimeToMilliseconds(hms) {
  const [hours, minutes, seconds] = hms.split(':');
  const totalSeconds = (+hours) * 3600 + (+minutes) * 60 + (+seconds);
  return totalSeconds * 1000;
}

function RemoveMilliseconds(timecode) {
  const parts = timecode.split('.');
  return parts[0];
}

function ConvertToMegabytes(bytes) {
  return ((bytes / 1024) / 1024).toFixed(2);
}

function CreateGuid() {
  function _p8(s) {
    const p = (Math.random().toString(16) + "000000000").substr(2, 8);
    return s ? "-" + p.substr(0, 4) + "-" + p.substr(4, 4) : p;
  }
  return _p8() + _p8(true) + _p8(true) + _p8();
}

// sha256 / hexToBase64 bevares som i original
function sha256(ascii) {
  function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
  var mathPow = Math.pow, maxWord = mathPow(2, 32), lengthProperty = 'length', i, j, result = '';
  var words = [], asciiBitLength = ascii[lengthProperty] * 8;
  var hash = sha256.h = sha256.h || [], k = sha256.k = sha256.k || [], primeCounter = k[lengthProperty];
  var isComposite = {};
  for (var candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
      hash[primeCounter] = (mathPow(candidate, .5) * maxWord) | 0;
      k[primeCounter++]  = (mathPow(candidate, 1/3) * maxWord) | 0;
    }
  }
  ascii += '\x80'; while (ascii[lengthProperty] % 64 - 56) ascii += '\x00';
  for (i = 0; i < ascii[lengthProperty]; i++) {
    j = ascii.charCodeAt(i); if (j >> 8) return;
    words[i >> 2] |= j << ((3 - i) % 4) * 8;
  }
  words[words[lengthProperty]] = ((asciiBitLength / maxWord) | 0);
  words[words[lengthProperty]] = (asciiBitLength);
  for (j = 0; j < words[lengthProperty];) {
    var w = words.slice(j, j += 16), oldHash = hash; hash = hash.slice(0, 8);
    for (i = 0; i < 64; i++) {
      var w15 = w[i - 15], w2 = w[i - 2], a = hash[0], e = hash[4];
      var temp1 = hash[7]
        + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
        + ((e & hash[5]) ^ ((~e) & hash[6]))
        + k[i]
        + (w[i] = (i < 16) ? w[i] : (w[i - 16]
          + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
          + w[i - 7]
          + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) | 0);
      var temp2 = (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
        + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
      hash = [(temp1 + temp2) | 0].concat(hash);
      hash[4] = (hash[4] + temp1) | 0;
    }
    for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
  }
  for (i = 0; i < 8; i++) for (j = 3; j + 1; j--) {
    var b = (hash[i] >> (j * 8)) & 255; result += ((b < 16) ? 0 : '') + b.toString(16);
  }
  return result;
}

function hexToBase64(hexstring) {
  return btoa(hexstring.match(/\w{2}/g).map(function (a) {
    return String.fromCharCode(parseInt(a, 16));
  }).join(""));
}

//////////////////////
// WEBSOCKET STATUS //
//////////////////////

function SetConnectionStatus(connected) {
  if (connected) {
    $status.style.background = "#2FB774";
    $status.innerText = "Connected!";
    $main.style.visibility = "visible";
    var tl = new TimelineMax();
    tl.to($status, 2, { opacity: 0, ease: Linear.easeNone });
  } else {
    $status.style.background = "#D12025";
    $status.innerText = "Connecting...";
    $status.style.opacity = 1;
    $main.style.visibility = "hidden";
  }
}

//////////////////////
// START UP / POLL  //
//////////////////////

connectws();

// Polls (som før)
setInterval(GetStreamStatus, 1000);
function GetStreamStatus() {
  if (ws.readyState !== WebSocket.CLOSED) {
    obswsSendRequest(ws, {
      requestType: "GetStreamStatus",
      requestId: CreateGuid(),
      requestData: {}
    });
  }
}

function GetStreamServiceSettings() {
  obswsSendRequest(ws, {
    requestType: "GetStreamServiceSettings",
    requestId: CreateGuid(),
    requestData: {}
  });
}

setInterval(GetProfileList, 200);
function GetProfileList() {
  obswsSendRequest(ws, {
    requestType: "GetProfileList",
    requestId: CreateGuid(),
    requestData: {}
  });
}

setInterval(GetStats, 1000);
function GetStats() {
  obswsSendRequest(ws, {
    requestType: "GetStats",
    requestId: CreateGuid(),
    requestData: {}
  });
}

setInterval(GetRecordStatus, 500);
function GetRecordStatus() {
  obswsSendRequest(ws, {
    requestType: "GetRecordStatus",
    requestId: CreateGuid(),
    requestData: {}
  });
}

if (obsMicInput !== "") {
  setInterval(GetInputMute, 500);
  function GetInputMute() {
    obswsSendRequest(ws, {
      requestType: "GetInputMute",
      requestId: CreateGuid(),
      requestData: { inputName: obsMicInput }
    });
  }
}

function GetVideoSettings() {
  obswsSendRequest(ws, {
    requestType: "GetVideoSettings",
    requestId: CreateGuid(),
    requestData: {}
  });
}
