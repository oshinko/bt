const uuid = require('./uuid.json');

const startSingleCaptureCommand = Buffer.from([1]);
const startStreamingCommand = Buffer.from([2]);
const stopStreamingCommand = Buffer.from([3]);
// Change PHY: [5, 0]: 1Mbps (default?), [5, 1]: 2Mbps
const use2MbpsCommand = Buffer.from([5, 1]);
const getBleParamsCommand = Buffer.from([6]);

const noble = require('noble');
const fs = require('fs');

const outputDir = 'output';

if (!fs.existsSync(outputDir)){
    fs.mkdirSync(outputDir);
}

function log(tag, ...args) {
    console.log(`[${new Date()}] ${tag}:`, ...args);
}

noble.on('discover', function(peripheral) {
    log('found device with local name', peripheral.advertisement.localName);
    log("advertising service UUIDs", peripheral.advertisement.serviceUuids);

    /*
    ペリフェラルに接続する前にスキャンを止めないと、
    noble 側はコネクション確立したことになるが、
    ペリフェラル側はしていないという謎の矛盾が発生する。
    スキャン継続による不安定な挙動は bluez などの低レイヤ起因 (だった気がする)
    */
    noble.stopScanning();

    peripheral.connect(function(error) {
        if (error) {
            log('connection error', error);
            return;
        }
        log('connected', peripheral.uuid);
        peripheral.discoverServices([uuid.service.replace(/-/g, '')], function(error, srvs) {
            if (error) {
                log('discover services error', error);
                return;
            }
            log('discovered services', srvs.map(x => x.uuid));
            let _rxUuid = uuid.rx.replace(/-/g, '');
            let _txUuid = uuid.tx.replace(/-/g, '');
            let _imgInfoUuid = uuid.imgInfo.replace(/-/g, '');
            let _cIMUuid = uuid.captureIntervalMinutes.replace(/-/g, '');
            let charUuids = [_rxUuid, _txUuid, _imgInfoUuid, _cIMUuid];
            let imageBuff = new Buffer(0);
            let imageByteLength = 0;
            let speedCheckBuff = new Buffer(0);
            let speedCheckSizesPerSec = [];
            let speedCheckSince = null;
            let speedCheckDispInterval = 60 * 1000;
            let speedCheckDispSince = null;
            srvs[0].discoverCharacteristics(charUuids, function(error, chars) {
                if (error) {
                    log('discover characteristics error', error);
                    return;
                }
                for (let char of chars) {
                    log('discovered characteristic', char.uuid);

                    if (char.uuid == _rxUuid) {
                        char.write(use2MbpsCommand, true, function(error) {
                            if (!error) log(char.uuid, 'use 2Mbps PHY');
                        });
                        char.write(startStreamingCommand, true, function(error) {
                            if (!error) log(char.uuid, 'start streaming');
                        });
                        char.write(getBleParamsCommand, true, function(error) {
                            if (error)
                                log(char.uuid, 'get BLE params command error', error);
                        });
                        function startSingleCapture() {
                            char.write(startSingleCaptureCommand, true, function(error) {
                                if (!error) log(char.uuid, 'REC');
                            });
                        }
                        startSingleCapture();
                        setInterval(startSingleCapture, 60 * 1000);
                    } else if (char.uuid == _txUuid) {
                        char.on('data', function(data, isNotification) {
                            // log('data', char.uuid, data);
                            imageBuff = Buffer.concat([imageBuff, data]);
                            if (imageBuff.byteLength >= imageByteLength) {
                                let path = `output/${Date.now()}`;
                                fs.writeFile(path, imageBuff, err => {
                                    if (err) throw err;
                                    log('save image to', path);
                                });
                                imageBuff = new Buffer(0);
                            }
                            // speed check
                            if (!speedCheckSince)
                                speedCheckSince = Date.now();
                            if (!speedCheckDispSince)
                                speedCheckDispSince = Date.now();
                            speedCheckBuff = Buffer.concat([speedCheckBuff, data]);
                            if (Date.now() - speedCheckSince >= 1000) {
                                speedCheckSizesPerSec.push(speedCheckBuff.byteLength);
                                speedCheckBuff = new Buffer(0);
                                speedCheckSince = null;
                            }
                            if (Date.now() - speedCheckDispSince >= speedCheckDispInterval) {
                                let sum = speedCheckSizesPerSec.reduce((x, y) => x + y);
                                let sizePerSec = Math.round(sum / speedCheckSizesPerSec.length);
                                log('throughput', sizePerSec, 'bytes / second');
                                speedCheckSizesPerSec = [];
                                speedCheckDispSince = null;
                            }
                        });
                        char.subscribe(function(error) {
                            if (error) {
                                log('subscribe error', char.uuid, error);
                                return;
                            }
                            log(char.uuid, 'notification enabled');
                        });
                    } else if (char.uuid == _imgInfoUuid) {
                        char.on('data', function(data, isNotification) {
                            log('image info', data, isNotification);

                            if (data[0] == 1) {
                                imageByteLength = data.readUIntLE(1, 4);
                                log('image size', imageByteLength, 'bytes');
                            } else {
                                log('unknown image info', data);
                            }
                        });
                        char.subscribe(function(error) {
                            if (error) {
                                log('subscribe error', char.uuid, error);
                                return;
                            }
                            log(char.uuid, 'notification enabled');
                        });
                    } else if (char.uuid == _cIMUuid) {
                        char.read(function(error, data) {
                            log('captureIntervalMinutes', data.readUIntLE(0, 1));
                        });
                    }
                }
            });
        });
    });
});

// allow duplicate peripheral to be returned (default false) on discovery event
const allowDuplicates = false;

noble.on('stateChange', function(state) {
    log('stateChange', state);
    if (state === 'poweredOn') {
        noble.startScanning([uuid.service.replace(/-/g, '')], allowDuplicates);
    } else {
        noble.stopScanning();
    }
});
