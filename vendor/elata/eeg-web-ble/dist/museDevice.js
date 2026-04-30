import { ElataError } from "@elata-biosciences/eeg-web";
const EEG_NAMES_ATHENA = [
    "TP9",
    "AF7",
    "AF8",
    "TP10",
    "AUX1",
    "AUX2",
    "AUX3",
    "AUX4",
];
const EEG_NAMES_CLASSIC = ["TP9", "AF7", "AF8", "TP10"];
function wasmGet(output, key) {
    if (!output || typeof output !== "object")
        return undefined;
    const map = output;
    const value = map[key];
    if (typeof value === "function") {
        return value.call(output);
    }
    return value;
}
function asNumberArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((v) => typeof v === "number");
}
export class MuseBleDevice {
    constructor(options = {}) {
        this.SERVICE_UUID = "0000fe8d-0000-1000-8000-00805f9b34fb";
        this.CHAR_UUIDS = {
            command: "273e0001-4c4d-454d-96be-f03bac821358",
            tp9: "273e0003-4c4d-454d-96be-f03bac821358",
            af7: "273e0004-4c4d-454d-96be-f03bac821358",
            af8: "273e0005-4c4d-454d-96be-f03bac821358",
            tp10: "273e0006-4c4d-454d-96be-f03bac821358",
            ppg1: "273e000f-4c4d-454d-96be-f03bac821358",
            ppg2: "273e0010-4c4d-454d-96be-f03bac821358",
            ppg3: "273e0011-4c4d-454d-96be-f03bac821358",
            athenaEeg: "273e0013-4c4d-454d-96be-f03bac821358",
            athenaOther: "273e0014-4c4d-454d-96be-f03bac821358",
        };
        this.samplingRate = 256;
        this.numEegChannels = 4;
        this.eegNames = EEG_NAMES_CLASSIC.slice();
        this.ppgNames = ["PPG1", "PPG2", "PPG3"];
        this.protocol = "classic";
        this.isAthena = false;
        this.opticsChannelCount = 0;
        this.availableCharacteristics = [];
        this.ppgMode = "none";
        this.athenaDecoder = null;
        this.device = null;
        this.server = null;
        this.service = null;
        this.commandChar = null;
        this.eegChars = {};
        this.ppgChars = {};
        this.athenaChars = {};
        this.eegBuffers = {};
        this.ppgBuffers = {
            PPG1: [],
            PPG2: [],
            PPG3: [],
        };
        this.isStreaming = false;
        this.ppgSampleCount = 0;
        this.ppgFallbackTimer = null;
        this.onDataCallback = null;
        this.onPpgCallback = null;
        this.athenaDecoderFactory = options.athenaDecoderFactory;
        this.sleepMs =
            options.sleepMs ||
                ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.logger = options.logger;
        this.onDisconnected = options.onDisconnected;
    }
    getBoardInfo() {
        const deviceName = this.device?.name || "Unknown";
        const isSynthetic = deviceName.toLowerCase().includes("synthetic") ||
            deviceName.toLowerCase().includes("muse-syn");
        const isAthena = this.protocol === "athena";
        return {
            device_name: this.device ? `${deviceName}` : "Muse / Synthetic Bridge",
            sample_rate_hz: this.samplingRate,
            channel_count: this.numEegChannels,
            eeg_channel_names: this.eegNames.slice(),
            board_id: isSynthetic ? -1 : isAthena ? -1 : 21,
            protocol: isAthena ? "athena" : "classic",
            optics_channel_count: isAthena ? this.opticsChannelCount : 0,
            description: isSynthetic
                ? "Synthetic EEG bridge emulating Muse protocol via BLE"
                : isAthena
                    ? "Muse S Athena (protocol v2) via Web Bluetooth"
                    : "Muse S / Muse 2 EEG headband via Web Bluetooth",
        };
    }
    getCharacteristicInfo() {
        return {
            service_uuid: this.SERVICE_UUID,
            characteristics: this.availableCharacteristics.slice(),
            protocol: this.protocol,
        };
    }
    decodeEegPacket(view) {
        const samples = [];
        for (let i = 2; i + 2 < view.length; i += 3) {
            let v1 = (view[i] << 4) | (view[i + 1] >> 4);
            let v2 = ((view[i + 1] & 0x0f) << 8) | view[i + 2];
            v1 = ((v1 - 0x800) * 125.0) / 256.0;
            v2 = ((v2 - 0x800) * 125.0) / 256.0;
            samples.push(v1, v2);
        }
        return samples;
    }
    decodePpgPacket(view) {
        if (view.length < 20) {
            return { sequence: 0, samples: [] };
        }
        const sequence = (view[0] << 8) | view[1];
        const data = view.slice(2, 20);
        const samples = [];
        for (let i = 0; i + 2 < data.length; i += 3) {
            samples.push((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        }
        return { sequence, samples };
    }
    splitPpgSamples(samples) {
        const ir = [];
        const nearIr = [];
        const red = [];
        for (let i = 0; i < samples.length; i += 3) {
            if (samples[i] !== undefined)
                ir.push(samples[i]);
            if (samples[i + 1] !== undefined)
                nearIr.push(samples[i + 1]);
            if (samples[i + 2] !== undefined)
                red.push(samples[i + 2]);
        }
        return { ir, nearIr, red };
    }
    async prepareSession() {
        if (!navigator.bluetooth) {
            throw new ElataError("BLE_UNAVAILABLE", "Web Bluetooth not available in this browser", {
                recoverable: false,
                details: { platform: typeof navigator !== "undefined" ? navigator.userAgent : "unknown" },
            });
        }
        this.device = await navigator.bluetooth.requestDevice({
            filters: [{ services: [this.SERVICE_UUID] }],
            optionalServices: [this.SERVICE_UUID],
        });
        this.device.addEventListener("gattserverdisconnected", () => {
            this.isStreaming = false;
            this.commandChar = null;
            if (this.logger)
                this.logger("gatt disconnected");
            if (this.onDisconnected)
                this.onDisconnected();
        });
        this.server = (await this.device.gatt?.connect()) ?? null;
        if (!this.server) {
            throw new ElataError("BLE_GATT_CONNECT_FAILED", "Failed to connect to GATT server", {
                recoverable: true,
            });
        }
        this.service = await this.server.getPrimaryService(this.SERVICE_UUID);
        const characteristics = await this.service.getCharacteristics();
        this.availableCharacteristics = characteristics.map((char) => char.uuid.toLowerCase());
        const hasAthena = this.availableCharacteristics.includes(this.CHAR_UUIDS.athenaEeg) &&
            this.availableCharacteristics.includes(this.CHAR_UUIDS.athenaOther);
        this.protocol = hasAthena ? "athena" : "classic";
        this.isAthena = hasAthena;
        this.commandChar = await this.service.getCharacteristic(this.CHAR_UUIDS.command);
        try {
            await this.commandChar.startNotifications();
            this.commandChar.addEventListener("characteristicvaluechanged", () => { });
        }
        catch (_) {
            // optional on some firmware
        }
        if (this.isAthena) {
            this.samplingRate = 256;
            this.numEegChannels = 8;
            this.eegNames = EEG_NAMES_ATHENA.slice();
            this.opticsChannelCount = 8;
            this.ppgMode = "athena";
            this.athenaChars.EEG = await this.service.getCharacteristic(this.CHAR_UUIDS.athenaEeg);
            this.athenaChars.OTHER = await this.service.getCharacteristic(this.CHAR_UUIDS.athenaOther);
            this.eegChars = {};
            this.ppgChars = {};
        }
        else {
            this.opticsChannelCount = 0;
            this.eegNames = EEG_NAMES_CLASSIC.slice();
            this.numEegChannels = 4;
            this.eegChars.TP9 = await this.service.getCharacteristic(this.CHAR_UUIDS.tp9);
            this.eegChars.AF7 = await this.service.getCharacteristic(this.CHAR_UUIDS.af7);
            this.eegChars.AF8 = await this.service.getCharacteristic(this.CHAR_UUIDS.af8);
            this.eegChars.TP10 = await this.service.getCharacteristic(this.CHAR_UUIDS.tp10);
            this.ppgChars = {};
            try {
                this.ppgChars.PPG1 = await this.service.getCharacteristic(this.CHAR_UUIDS.ppg1);
            }
            catch (_) { }
            try {
                this.ppgChars.PPG2 = await this.service.getCharacteristic(this.CHAR_UUIDS.ppg2);
            }
            catch (_) { }
            try {
                this.ppgChars.PPG3 = await this.service.getCharacteristic(this.CHAR_UUIDS.ppg3);
            }
            catch (_) { }
            const ppgCount = Object.keys(this.ppgChars).length;
            if (ppgCount === 1)
                this.ppgMode = "interleaved";
            else if (ppgCount >= 2)
                this.ppgMode = "per-channel";
            else
                this.ppgMode = "none";
        }
    }
    async sendCommand(cmd) {
        if (!this.commandChar)
            return;
        const bytes = new Uint8Array(cmd.length + 2);
        bytes[0] = cmd.length + 1;
        for (let i = 0; i < cmd.length; i++)
            bytes[i + 1] = cmd.charCodeAt(i);
        bytes[bytes.length - 1] = 10;
        const char = this.commandChar;
        if (typeof char.writeValueWithoutResponse === "function") {
            await char.writeValueWithoutResponse(bytes);
        }
        else {
            await this.commandChar.writeValue(bytes);
        }
    }
    processClassicEegBuffers() {
        const minSamples = Math.min(this.eegBuffers.TP9.length, this.eegBuffers.AF7.length, this.eegBuffers.AF8.length, this.eegBuffers.TP10.length);
        if (minSamples < 12)
            return;
        const samples = [];
        const samplesToProcess = Math.min(minSamples, 24);
        for (let i = 0; i < samplesToProcess; i++) {
            samples.push([
                this.eegBuffers.TP9.shift(),
                this.eegBuffers.AF7.shift(),
                this.eegBuffers.AF8.shift(),
                this.eegBuffers.TP10.shift(),
            ]);
        }
        if (this.onDataCallback && samples.length > 0) {
            this.onDataCallback(samples);
        }
    }
    async startStream(callback, ppgCallback = null) {
        if (this.isStreaming)
            return;
        if (!this.commandChar)
            throw new Error("Muse not connected");
        this.onDataCallback = callback;
        this.onPpgCallback = ppgCallback;
        this.isStreaming = true;
        this.ppgSampleCount = 0;
        if (this.ppgFallbackTimer !== null) {
            clearTimeout(this.ppgFallbackTimer);
            this.ppgFallbackTimer = null;
        }
        this.eegBuffers = {};
        for (const ch of this.eegNames)
            this.eegBuffers[ch] = [];
        for (const ch of this.ppgNames)
            this.ppgBuffers[ch] = [];
        if (this.isAthena) {
            if (!this.athenaDecoderFactory) {
                throw new Error("Athena support requires an Athena decoder factory");
            }
            if (!this.athenaDecoder)
                this.athenaDecoder = this.athenaDecoderFactory();
            else
                this.athenaDecoder.reset();
            this.athenaDecoder.set_use_device_timestamps(true);
            this.athenaDecoder.set_clock_kind("windowed");
            this.athenaDecoder.set_reorder_window_ms(0);
            const handleAthenaNotification = (event) => {
                const target = event.target;
                const value = target.value;
                if (!value)
                    return;
                const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
                let output;
                try {
                    output = this.athenaDecoder?.decode(view);
                }
                catch (err) {
                    if (this.logger)
                        this.logger(`athena decode error: ${String(err)}`);
                    return;
                }
                const eegSamples = asNumberArray(wasmGet(output, "eeg_samples"));
                const eegChannels = Number(wasmGet(output, "eeg_channel_count") || 0);
                if (eegSamples.length > 0 && eegChannels > 0 && this.onDataCallback) {
                    if (this.numEegChannels !== eegChannels) {
                        this.numEegChannels = eegChannels;
                        this.eegNames = EEG_NAMES_ATHENA.slice(0, eegChannels);
                    }
                    const rows = [];
                    const sampleCount = Math.floor(eegSamples.length / eegChannels);
                    for (let i = 0; i < sampleCount; i++) {
                        const row = new Array(eegChannels);
                        const base = i * eegChannels;
                        for (let ch = 0; ch < eegChannels; ch++)
                            row[ch] = eegSamples[base + ch];
                        rows.push(row);
                    }
                    if (rows.length > 0)
                        this.onDataCallback(rows);
                }
                if (this.onPpgCallback) {
                    const opticsSamples = asNumberArray(wasmGet(output, "optics_samples"));
                    const opticsChannelCount = Number(wasmGet(output, "optics_channel_count") || 0);
                    if (opticsChannelCount > 0)
                        this.opticsChannelCount = opticsChannelCount;
                    const accgyroSamples = asNumberArray(wasmGet(output, "accgyro_samples"));
                    const batterySamples = asNumberArray(wasmGet(output, "battery_samples"));
                    const hasAux = opticsSamples.length > 0 ||
                        accgyroSamples.length > 0 ||
                        batterySamples.length > 0;
                    if (hasAux) {
                        this.onPpgCallback("athena", {
                            optics: {
                                samples: opticsSamples,
                                channel_count: opticsChannelCount,
                                timestamps_ms: asNumberArray(wasmGet(output, "optics_timestamps_ms")),
                            },
                            accgyro: {
                                samples: accgyroSamples,
                                timestamps_ms: asNumberArray(wasmGet(output, "accgyro_timestamps_ms")),
                            },
                            battery: {
                                samples: batterySamples,
                                timestamps_ms: asNumberArray(wasmGet(output, "battery_timestamps_ms")),
                            },
                        });
                    }
                }
            };
            for (const char of Object.values(this.athenaChars)) {
                await char.startNotifications();
                char.addEventListener("characteristicvaluechanged", handleAthenaNotification);
            }
            await this.sendCommand("v6");
            await this.sleepMs(200);
            await this.sendCommand("s");
            await this.sleepMs(200);
            await this.sendCommand("h");
            await this.sleepMs(200);
            await this.sendCommand("p1041");
            await this.sleepMs(200);
            await this.sendCommand("s");
            await this.sleepMs(200);
            await this.sendCommand("dc001");
            await this.sleepMs(50);
            await this.sendCommand("dc001");
            await this.sleepMs(100);
            await this.sendCommand("s");
            return;
        }
        const handleNotification = (channelName) => (event) => {
            const target = event.target;
            const value = target.value;
            if (!value)
                return;
            const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            const samples = this.decodeEegPacket(view);
            this.eegBuffers[channelName].push(...samples);
            this.processClassicEegBuffers();
        };
        for (const [name, char] of Object.entries(this.eegChars)) {
            await char.startNotifications();
            char.addEventListener("characteristicvaluechanged", handleNotification(name));
        }
        const handlePpgNotification = (channelName) => (event) => {
            const target = event.target;
            const value = target.value;
            if (!value)
                return;
            const view = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
            const packet = this.decodePpgPacket(view);
            if (packet.samples.length === 0)
                return;
            this.ppgSampleCount += packet.samples.length;
            if (this.ppgMode === "interleaved") {
                const split = this.splitPpgSamples(packet.samples);
                this.ppgBuffers.PPG1.push(...split.ir);
                this.ppgBuffers.PPG2.push(...split.nearIr);
                this.ppgBuffers.PPG3.push(...split.red);
                if (this.onPpgCallback) {
                    this.onPpgCallback("interleaved", {
                        sequence: packet.sequence,
                        ...split,
                    });
                }
            }
            else {
                this.ppgBuffers[channelName].push(...packet.samples);
                if (this.onPpgCallback)
                    this.onPpgCallback(channelName, packet);
            }
        };
        for (const [name, char] of Object.entries(this.ppgChars)) {
            await char.startNotifications();
            char.addEventListener("characteristicvaluechanged", handlePpgNotification(name));
        }
        await this.sendCommand("v1");
        await this.sendCommand("p21");
        await this.sendCommand("d");
        this.ppgFallbackTimer = window.setTimeout(async () => {
            if (this.ppgSampleCount > 0)
                return;
            await this.sendCommand("h");
            await this.sendCommand("p50");
            await this.sendCommand("d");
        }, 3000);
    }
    async stopStream() {
        if (!this.isStreaming)
            return;
        if (this.commandChar)
            await this.sendCommand("h");
        const dataChars = this.isAthena
            ? Object.values(this.athenaChars)
            : Object.values(this.eegChars);
        for (const char of dataChars) {
            try {
                await char.stopNotifications();
            }
            catch (_) { }
        }
        for (const char of Object.values(this.ppgChars)) {
            try {
                await char.stopNotifications();
            }
            catch (_) { }
        }
        if (this.ppgFallbackTimer !== null) {
            clearTimeout(this.ppgFallbackTimer);
            this.ppgFallbackTimer = null;
        }
        this.isStreaming = false;
    }
    async releaseSession() {
        await this.stopStream();
        if (this.device?.gatt?.connected)
            this.device.gatt.disconnect();
        this.device = null;
        this.server = null;
        this.service = null;
        this.commandChar = null;
        this.eegChars = {};
        this.ppgChars = {};
        this.athenaChars = {};
        this.athenaDecoder = null;
        this.isAthena = false;
        this.protocol = "classic";
        this.opticsChannelCount = 0;
        if (this.ppgFallbackTimer !== null) {
            clearTimeout(this.ppgFallbackTimer);
            this.ppgFallbackTimer = null;
        }
    }
}
