// Candelabra WebDFU — application logic using devanlai/webdfu library

const REPO = "bseishen/Candelabra";
const PAGES_BASE = "https://bseishen.github.io/candelabra-web";
const FLASH_START = 0x08000000;

const USB_FILTERS_DEVICE = [
    { vendorId: 0x1D50, productId: 0x606F }, // Candlelight
    { vendorId: 0x16D0, productId: 0x117E }, // Slcan
];
const USB_FILTERS_DFU = [
    { vendorId: 0x0483, productId: 0xDF11 }, // STM32 DFU bootloader
];

let releases = [];
let dfuDevice = null;
let transferSize = 2048;
let manualFirmware = null; // ArrayBuffer from file upload
let manualStartAddress = null; // start address from hex file, if provided

// ── Logging ──

function log(msg, level) {
    var el = document.getElementById("log");
    var line = document.createElement("div");
    line.textContent = "> " + msg;
    if (level === "error") line.style.color = "#f87171";
    if (level === "ok")    line.style.color = "#4ade80";
    if (level === "warn")  line.style.color = "#fbbf24";
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
    console.log("[WebDFU]", msg);
}

function setProgress(bytes_sent, expected_size) {
    var bar = document.getElementById("progress-fill");
    var label = document.getElementById("progress-label");
    if (typeof expected_size !== "undefined" && expected_size > 0) {
        var pct = Math.round((bytes_sent / expected_size) * 100);
        bar.style.width = pct + "%";
        label.textContent = pct + "% (" + bytes_sent + " / " + expected_size + " bytes)";
    } else {
        label.textContent = bytes_sent + " bytes";
    }
}

function resetProgress() {
    document.getElementById("progress-fill").style.width = "0%";
    document.getElementById("progress-label").textContent = "";
}

function setStatus(id, text, ok) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = "status " + (ok ? "status-ok" : "status-pending");
}

// ── Intel HEX Parser ──

function parseIntelHex(text) {
    var lines = text.split(/\r?\n/).filter(function(l) { return l.startsWith(":"); });
    if (lines.length === 0) throw new Error("No valid Intel HEX records found");

    var baseAddress = 0;
    var records = [];
    var minAddr = Infinity;
    var maxAddr = 0;

    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.length < 11) continue;

        var byteCount = parseInt(line.substr(1, 2), 16);
        var address = parseInt(line.substr(3, 4), 16);
        var type = parseInt(line.substr(7, 2), 16);
        var dataHex = line.substr(9, byteCount * 2);
        var checksum = parseInt(line.substr(9 + byteCount * 2, 2), 16);

        // Verify checksum
        var sum = byteCount + (address >> 8) + (address & 0xFF) + type;
        for (var c = 0; c < byteCount; c++) {
            sum += parseInt(dataHex.substr(c * 2, 2), 16);
        }
        sum = ((~sum) + 1) & 0xFF;
        if (sum !== checksum) {
            throw new Error("Checksum mismatch on line " + (i + 1) + ": expected 0x" +
                sum.toString(16) + ", got 0x" + checksum.toString(16));
        }

        if (type === 0x00) {
            // Data record
            var absAddr = baseAddress + address;
            var data = new Uint8Array(byteCount);
            for (var d = 0; d < byteCount; d++) {
                data[d] = parseInt(dataHex.substr(d * 2, 2), 16);
            }
            records.push({ address: absAddr, data: data });
            if (absAddr < minAddr) minAddr = absAddr;
            if (absAddr + byteCount > maxAddr) maxAddr = absAddr + byteCount;
        } else if (type === 0x01) {
            // EOF
            break;
        } else if (type === 0x02) {
            // Extended Segment Address
            baseAddress = parseInt(dataHex, 16) << 4;
        } else if (type === 0x04) {
            // Extended Linear Address
            baseAddress = parseInt(dataHex, 16) << 16;
        }
    }

    if (records.length === 0) throw new Error("No data records found in HEX file");

    // Fill with 0xFF (erased flash)
    var size = maxAddr - minAddr;
    var binary = new Uint8Array(size);
    binary.fill(0xFF);
    for (var r = 0; r < records.length; r++) {
        binary.set(records[r].data, records[r].address - minAddr);
    }

    return { data: binary.buffer, startAddress: minAddr };
}

// ── GitHub Releases ──

async function fetchReleases() {
    log("Fetching releases from GitHub...");
    try {
        var resp = await fetch("https://api.github.com/repos/" + REPO + "/releases");
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        releases = await resp.json();
        if (releases.length === 0) {
            log("No releases found", "warn");
            return;
        }
        var sel = document.getElementById("release-select");
        sel.innerHTML = "";
        releases.forEach(function(r) {
            var opt = document.createElement("option");
            opt.value = r.tag_name;
            opt.textContent = r.name || r.tag_name;
            sel.appendChild(opt);
        });
        log("Found " + releases.length + " release(s)", "ok");
        populateAssets();
    } catch (e) {
        log("Failed to fetch releases: " + e.message, "error");
    }
}

function getSelectedRelease() {
    var tag = document.getElementById("release-select").value;
    return releases.find(function(r) { return r.tag_name === tag; });
}

function getBinAssets(release) {
    if (!release) return [];
    return release.assets.filter(function(a) { return a.name.endsWith(".bin"); });
}

function parseAssetName(name) {
    var m = name.match(/^(Candlelight|Slcan)_(STM32\w+)_(\w+)\.bin$/);
    if (!m) return null;
    return { mcu: m[2], firmware: m[1], board: m[3] };
}

function populateAssets() {
    var release = getSelectedRelease();
    var assets = getBinAssets(release);
    var boards = new Map();
    assets.forEach(function(a) {
        var p = parseAssetName(a.name);
        if (p) boards.set(p.board, true);
    });

    var bSel = document.getElementById("board-select");
    bSel.innerHTML = "";
    boards.forEach(function(_, board) {
        var opt = document.createElement("option");
        opt.value = board;
        opt.textContent = board;
        bSel.appendChild(opt);
    });

    populateFirmwareTypes();
}

function populateFirmwareTypes() {
    var release = getSelectedRelease();
    var assets = getBinAssets(release);
    var board = document.getElementById("board-select").value;
    var types = new Map();
    assets.forEach(function(a) {
        var p = parseAssetName(a.name);
        if (p && p.board === board) types.set(p.firmware, true);
    });

    var fSel = document.getElementById("firmware-select");
    fSel.innerHTML = "";
    types.forEach(function(_, fw) {
        var opt = document.createElement("option");
        opt.value = fw;
        opt.textContent = fw;
        fSel.appendChild(opt);
    });

    updateSelectedFile();
}

function updateSelectedFile() {
    var board = document.getElementById("board-select").value;
    var fw = document.getElementById("firmware-select").value;
    var release = getSelectedRelease();
    var assets = getBinAssets(release);
    var match = assets.find(function(a) {
        var p = parseAssetName(a.name);
        return p && p.board === board && p.firmware === fw;
    });
    document.getElementById("selected-file").textContent = match ? match.name : "No matching firmware found";
}

function getSelectedAsset() {
    var board = document.getElementById("board-select").value;
    var fw = document.getElementById("firmware-select").value;
    var release = getSelectedRelease();
    var assets = getBinAssets(release);
    return assets.find(function(a) {
        var p = parseAssetName(a.name);
        return p && p.board === board && p.firmware === fw;
    });
}

// ── USB: Enter DFU Mode (Candlelight only) ──

async function enterDFUMode() {
    log("Requesting USB device (Candlelight)...");
    try {
        var device = await navigator.usb.requestDevice({ filters: USB_FILTERS_DEVICE });
        log("Connected to: " + (device.productName || "device"));

        // Find the DFU runtime interface on the running device
        var dfuInterfaces = dfu.findDeviceDfuInterfaces(device);
        if (dfuInterfaces.length === 0) {
            log("No DFU interface found — this device may be running Slcan. Use BOOT0 instead.", "warn");
            return;
        }

        var runtime = new dfu.Device(device, dfuInterfaces[0]);
        await runtime.open();

        log("Sending DFU_DETACH...");
        try {
            await runtime.detach();
        } catch (e) {
            log("Detach request sent (device may have already started rebooting)");
        }

        log("Waiting for device to disconnect...");
        try {
            await runtime.waitDisconnected(5000);
            log("Device disconnected, rebooting into DFU bootloader...", "ok");
        } catch (e) {
            log("Device did not disconnect — it may require a USB cable reconnect", "warn");
        }

        await runtime.close();
        setStatus("step2-status", "DFU detach sent", true);
        log("Wait a few seconds, then click 'Connect DFU Bootloader'");
    } catch (e) {
        if (e.name === "NotFoundError") {
            log("No device selected", "warn");
        } else {
            log("Error: " + e.message, "error");
        }
    }
}

// ── USB: Connect DFU Bootloader ──

async function connectDFU() {
    log("Requesting STM32 DFU bootloader...");
    try {
        var device = await navigator.usb.requestDevice({ filters: USB_FILTERS_DFU });
        log("Connected to: " + (device.productName || "STM32 BOOTLOADER"));

        var interfaces = dfu.findDeviceDfuInterfaces(device);
        if (interfaces.length === 0) {
            log("No DFU interfaces found on device", "error");
            return;
        }

        // Log all available interfaces
        for (var i = 0; i < interfaces.length; i++) {
            log("  Interface " + i + ": " + (interfaces[i].name || "unnamed"));
        }

        // Find the Internal Flash interface (DfuSe protocol = 0x02)
        var flashIntf = null;
        for (var j = 0; j < interfaces.length; j++) {
            if (interfaces[j].name && interfaces[j].name.indexOf("Internal Flash") !== -1) {
                flashIntf = interfaces[j];
                break;
            }
        }
        if (!flashIntf) {
            // Fall back to first interface with DfuSe protocol
            for (var k = 0; k < interfaces.length; k++) {
                if (interfaces[k].alternate.interfaceProtocol === 0x02) {
                    flashIntf = interfaces[k];
                    break;
                }
            }
        }
        if (!flashIntf) {
            flashIntf = interfaces[0];
        }

        log("Using: " + (flashIntf.name || "alternate " + flashIntf.alternate.alternateSetting));

        // Use dfuse.Device for DfuSe protocol
        if (flashIntf.alternate.interfaceProtocol === 0x02) {
            dfuDevice = new dfuse.Device(device, flashIntf);
        } else {
            dfuDevice = new dfu.Device(device, flashIntf);
        }

        // Wire up logging
        dfuDevice.logDebug = function(msg) { console.log("[DFU debug]", msg); };
        dfuDevice.logInfo = function(msg) { log(msg); };
        dfuDevice.logWarning = function(msg) { log(msg, "warn"); };
        dfuDevice.logError = function(msg) { log(msg, "error"); };
        dfuDevice.logProgress = setProgress;

        try {
            await dfuDevice.open();
        } catch (openErr) {
            var errMsg = openErr.message || String(openErr);
            if (errMsg.indexOf("Access denied") !== -1) {
                log("Access denied — on Windows, install the WinUSB driver with Zadig (see Step 2)", "error");
            } else {
                log("Cannot open device: " + errMsg, "error");
            }
            dfuDevice = null;
            return;
        }

        // Read the DFU functional descriptor for transfer size
        try {
            var desc = await dfuDevice.readConfigurationDescriptor(0);
            var configDesc = dfu.parseConfigurationDescriptor(desc);
            for (var d of configDesc.descriptors) {
                if (d.wTransferSize) {
                    transferSize = d.wTransferSize;
                    log("Transfer size: " + transferSize + " bytes");
                    break;
                }
            }
        } catch (e) {
            log("Using default transfer size: " + transferSize, "warn");
        }

        // Try to read interface names for memory map (Chrome on Windows often lacks these)
        if (!dfuDevice.memoryInfo) {
            try {
                var interfaceNames = await dfuDevice.readInterfaceNames();
                var confValue = flashIntf.configuration.configurationValue;
                var intfNum = flashIntf["interface"].interfaceNumber;
                var altSetting = flashIntf.alternate.alternateSetting;
                if (interfaceNames[confValue] &&
                    interfaceNames[confValue][intfNum] &&
                    interfaceNames[confValue][intfNum][altSetting]) {
                    var name = interfaceNames[confValue][intfNum][altSetting];
                    log("Interface name: " + name);
                    dfuDevice.memoryInfo = dfuse.parseMemoryDescriptor(name);
                }
            } catch (e) {
                log("Could not read interface names: " + (e.message || e), "warn");
            }
        }

        // Fallback: provide a known memory map for STM32G4/G0 if descriptor parsing failed
        if (!dfuDevice.memoryInfo) {
            log("No memory descriptor from device, using STM32 fallback memory map", "warn");
            dfuDevice.memoryInfo = {
                "name": "Internal Flash",
                "segments": [
                    { start: 0x08000000, sectorSize: 2048, end: 0x08080000,
                      readable: true, erasable: true, writable: true }
                ]
            };
        }

        log("Memory: " + dfuDevice.memoryInfo.name);
        for (var seg of dfuDevice.memoryInfo.segments) {
            var size = seg.end - seg.start;
            var props = (seg.readable ? "r" : "") + (seg.writable ? "w" : "") + (seg.erasable ? "e" : "");
            log("  0x" + seg.start.toString(16) + " - 0x" + seg.end.toString(16) +
                " (" + (size/1024) + "KB, sector " + seg.sectorSize + "B, " + props + ")");
        }

        // Ensure idle state
        var state = await dfuDevice.getState();
        if (state === dfu.dfuERROR) {
            await dfuDevice.clearStatus();
            state = await dfuDevice.getState();
        }
        if (state !== dfu.dfuIDLE) {
            await dfuDevice.abortToIdle();
        }

        log("DFU bootloader ready", "ok");
        setStatus("step3-status", "Bootloader connected", true);
        document.getElementById("btn-flash").disabled = false;

    } catch (e) {
        if (e.name === "NotFoundError") {
            log("No DFU device selected", "warn");
        } else {
            log("Error: " + (e.message || e), "error");
        }
    }
}

// ── Flash Firmware ──

async function flashFirmware() {
    if (!dfuDevice) {
        log("Connect to DFU bootloader first", "error");
        return;
    }

    var asset = getSelectedAsset();
    if (!asset && !manualFirmware) {
        log("No firmware file selected", "error");
        return;
    }

    document.getElementById("btn-flash").disabled = true;
    resetProgress();

    try {
        var firmware;
        if (manualFirmware) {
            firmware = manualFirmware;
            log("Using uploaded file (" + firmware.byteLength + " bytes)");
        } else {
            var tag = document.getElementById("release-select").value;
            var binUrl = PAGES_BASE + "/firmware/" + tag + "/" + asset.name;
            log("Downloading " + asset.name + "...");
            try {
                var resp = await fetch(binUrl);
                if (!resp.ok) throw new Error("HTTP " + resp.status);
                firmware = await resp.arrayBuffer();
            } catch (fetchErr) {
                log("Cannot download firmware. Please use 'Upload .bin file' instead.", "error");
                log("Download the .bin from: " + asset.browser_download_url, "warn");
                document.getElementById("btn-flash").disabled = false;
                return;
            }
            log("Downloaded " + firmware.byteLength + " bytes", "ok");
        }

        // Set start address for DfuSe (use hex file address if available)
        var flashAddr = (manualFirmware && manualStartAddress !== null) ? manualStartAddress : FLASH_START;
        if (dfuDevice.startAddress !== undefined) {
            dfuDevice.startAddress = flashAddr;
        }

        // Erase + write without manifestation so device stays in DFU for verify
        log("Erasing flash at 0x" + flashAddr.toString(16) + "...");
        await dfuDevice.erase(flashAddr, firmware.byteLength);

        log("Writing firmware...");
        var bytesSent = 0;
        var expectedSize = firmware.byteLength;
        var address = flashAddr;
        while (bytesSent < expectedSize) {
            var chunkSize = Math.min(expectedSize - bytesSent, transferSize);
            await dfuDevice.dfuseCommand(dfuse.SET_ADDRESS, address, 4);
            var bytesWritten = await dfuDevice.download(firmware.slice(bytesSent, bytesSent + chunkSize), 2);
            await dfuDevice.poll_until_idle(dfu.dfuDNLOAD_IDLE);
            bytesSent += bytesWritten;
            address += chunkSize;
            setProgress(bytesSent, expectedSize);
        }

        document.getElementById("progress-fill").style.width = "100%";
        document.getElementById("progress-label").textContent = "Write complete";
        log("Wrote " + bytesSent + " bytes", "ok");

        // Verify: read back and compare before manifesting
        log("Verifying flash contents...");
        resetProgress();

        await dfuDevice.abortToIdle();
        dfuDevice.startAddress = flashAddr;
        var readBlob = await dfuDevice.do_upload(transferSize, firmware.byteLength);
        var readBuf = await readBlob.arrayBuffer();
        var written = new Uint8Array(firmware);
        var readBack = new Uint8Array(readBuf);

        var mismatchCount = 0;
        var firstMismatch = -1;
        var compareLen = Math.min(written.length, readBack.length);
        for (var v = 0; v < compareLen; v++) {
            if (written[v] !== readBack[v]) {
                mismatchCount++;
                if (firstMismatch === -1) firstMismatch = v;
            }
        }
        if (readBack.length < written.length) {
            mismatchCount += written.length - readBack.length;
            if (firstMismatch === -1) firstMismatch = readBack.length;
        }

        if (mismatchCount > 0) {
            log("VERIFY FAILED — " + mismatchCount + " byte(s) differ, first at offset 0x" +
                firstMismatch.toString(16), "error");
            log("  Expected 0x" + written[firstMismatch].toString(16).padStart(2, "0") +
                " got 0x" + (firstMismatch < readBack.length ?
                readBack[firstMismatch].toString(16).padStart(2, "0") : "??"), "error");
            document.getElementById("progress-fill").style.width = "100%";
            document.getElementById("progress-fill").style.background = "var(--red)";
            document.getElementById("progress-label").textContent = "Verify FAILED";
            setStatus("step3-status", "Verify failed — device NOT rebooted", false);
            document.getElementById("btn-flash").disabled = false;
            dfuDevice = null;
            return;
        }

        log("Verify OK — " + compareLen + " bytes match", "ok");

        // Manifest: tell device to boot into new firmware
        log("Manifesting...");
        await dfuDevice.abortToIdle();
        await dfuDevice.dfuseCommand(dfuse.SET_ADDRESS, flashAddr, 4);
        await dfuDevice.download(new ArrayBuffer(), 0);
        try {
            await dfuDevice.poll_until(function(state) { return state === dfu.dfuMANIFEST; });
        } catch (e) {
            // device may disconnect during manifest — that's normal
        }

        document.getElementById("progress-fill").style.width = "100%";
        document.getElementById("progress-label").textContent = "Verified & Complete!";
        log("Firmware verified and device rebooting", "ok");
        setStatus("step3-status", "Flash verified!", true);
        dfuDevice = null;
    } catch (e) {
        log("Flash failed: " + (e.message || e), "error");
        document.getElementById("btn-flash").disabled = false;
    }
}

// ── Init ──

document.addEventListener("DOMContentLoaded", function() {
    if (!navigator.usb) {
        log("WebUSB is not supported in this browser. Use Chrome or Edge.", "error");
        document.querySelectorAll("button").forEach(function(b) { b.disabled = true; });
        return;
    }

    document.getElementById("file-upload").addEventListener("change", function(e) {
        var file = e.target.files[0];
        if (!file) return;
        var isHex = file.name.toLowerCase().endsWith(".hex");
        if (isHex) {
            var textReader = new FileReader();
            textReader.onload = function() {
                try {
                    var result = parseIntelHex(textReader.result);
                    manualFirmware = result.data;
                    manualStartAddress = result.startAddress;
                    log("Parsed HEX file: " + file.name + " (" + manualFirmware.byteLength +
                        " bytes, start 0x" + manualStartAddress.toString(16) + ")", "ok");
                    document.getElementById("selected-file").textContent = file.name + " (uploaded, " +
                        manualFirmware.byteLength + " bytes @ 0x" + manualStartAddress.toString(16) + ")";
                } catch (err) {
                    log("Failed to parse HEX file: " + err.message, "error");
                    manualFirmware = null;
                    manualStartAddress = null;
                }
            };
            textReader.readAsText(file);
        } else {
            var reader = new FileReader();
            reader.onload = function() {
                manualFirmware = reader.result;
                manualStartAddress = null;
                log("Loaded file: " + file.name + " (" + manualFirmware.byteLength + " bytes)", "ok");
                document.getElementById("selected-file").textContent = file.name + " (uploaded)";
            };
            reader.readAsArrayBuffer(file);
        }
    });

    document.getElementById("release-select").addEventListener("change", populateAssets);
    document.getElementById("board-select").addEventListener("change", populateFirmwareTypes);
    document.getElementById("firmware-select").addEventListener("change", updateSelectedFile);
    document.getElementById("btn-enter-dfu").addEventListener("click", enterDFUMode);
    document.getElementById("btn-connect-dfu").addEventListener("click", connectDFU);
    document.getElementById("btn-flash").addEventListener("click", flashFirmware);

    fetchReleases();
});
