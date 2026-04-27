"use strict";
const blockTemplate = require("node-blocktemplate");
const BLOB_TYPE = Object.freeze({
    CRYPTONOTE: 0, FORKNOTE1: 1, FORKNOTE2: 2, CRYPTONOTE2: 3, RYO: 4, LOKI: 5, CRYPTONOTE3: 6, AEON: 7,
    CUCKAROO: 8, XTNC: 9, TUBE: 10, XHV: 11, XTA: 12, ZEPH: 13, XLA: 14, SAL: 15, ARQ: 16, XEQ: 22,
    DERO: 100, RTM: 104, KCN: 105, XTM_T: 106
});
const BLOB_TYPES = new Map(Object.entries({
    cryptonote: BLOB_TYPE.CRYPTONOTE, forknote1: BLOB_TYPE.FORKNOTE1, forknote2: BLOB_TYPE.FORKNOTE2, cryptonote2: BLOB_TYPE.CRYPTONOTE2,
    cryptonote_ryo: BLOB_TYPE.RYO, cryptonote_loki: BLOB_TYPE.LOKI, cryptonote3: BLOB_TYPE.CRYPTONOTE3, aeon: BLOB_TYPE.AEON,
    cuckaroo: BLOB_TYPE.CUCKAROO, cryptonote_xtnc: BLOB_TYPE.XTNC, cryptonote_tube: BLOB_TYPE.TUBE,
    cryptonote_xhv: BLOB_TYPE.XHV, cryptonote_xta: BLOB_TYPE.XTA, cryptonote_zeph: BLOB_TYPE.ZEPH,
    cryptonote_xla: BLOB_TYPE.XLA, cryptonote_sal: BLOB_TYPE.SAL, cryptonote_arq: BLOB_TYPE.ARQ,
    cryptonote_xeq: BLOB_TYPE.XEQ, cryptonote_dero: BLOB_TYPE.DERO, raptoreum: BLOB_TYPE.RTM,
    raptoreum_kcn: BLOB_TYPE.KCN, "xtm-t": BLOB_TYPE.XTM_T
}));
const GRIN_BLOB_TYPES = new Set([BLOB_TYPE.CUCKAROO, BLOB_TYPE.XTNC, BLOB_TYPE.TUBE, BLOB_TYPE.XTA]);
const PASSTHROUGH_BLOB_TYPES = new Set([BLOB_TYPE.DERO, BLOB_TYPE.XTM_T]);
const SPECIAL_BLOB_HANDLERS = new Map([
    [BLOB_TYPE.RTM, {
        convert: (blobBuffer) => blockTemplate.convertRtmBlob(blobBuffer),
        construct: (blockTemplateBuffer, nonceBuffer) => blockTemplate.constructNewRtmBlob(blockTemplateBuffer, nonceBuffer)
    }],
    [BLOB_TYPE.KCN, {
        convert: (blobBuffer) => blockTemplate.convertKcnBlob(blobBuffer),
        construct: (blockTemplateBuffer, nonceBuffer) => blockTemplate.constructNewKcnBlob(blockTemplateBuffer, nonceBuffer)
    }]
]);
function parseBlobType(blobTypeValue) {
    if (typeof blobTypeValue === "string") {
        return BLOB_TYPES.get(blobTypeValue) ?? BLOB_TYPE.CRYPTONOTE;
    }
    if (Number.isInteger(blobTypeValue)) return blobTypeValue;
    return BLOB_TYPE.CRYPTONOTE;
}
function blobTypeGrin(blobTypeNum) {
    return GRIN_BLOB_TYPES.has(blobTypeNum);
}
function blobTypePassthrough(blobTypeNum) {
    return PASSTHROUGH_BLOB_TYPES.has(blobTypeNum);
}
function nonceSize(blobTypeNum) {
    return blobTypeNum === BLOB_TYPE.AEON ? 8 : 4;
}

function c29ProofSize(blobTypeNum) {
    switch (blobTypeNum) {
    case BLOB_TYPE.TUBE: return 40;
    case BLOB_TYPE.XTA: return 48;
    default: return 32;
    }
}

function convertBlob(blobBuffer, blobTypeNum) {
    if (blobTypePassthrough(blobTypeNum)) {
        return Buffer.from(blobBuffer);
    }
    const handler = SPECIAL_BLOB_HANDLERS.get(blobTypeNum);
    if (handler) return handler.convert(blobBuffer);
    return blockTemplate.convert_blob(blobBuffer, blobTypeNum);
}
function constructNewBlob(blockTemplateBuffer, nonceBuffer, blobTypeNum, ring) {
    if (blobTypePassthrough(blobTypeNum)) {
        const newBlob = Buffer.alloc(blockTemplateBuffer.length);
        blockTemplateBuffer.copy(newBlob);
        nonceBuffer.copy(newBlob, 39, 0, 4);
        return newBlob;
    }
    const handler = SPECIAL_BLOB_HANDLERS.get(blobTypeNum);
    if (handler) return handler.construct(blockTemplateBuffer, nonceBuffer);
    return blockTemplate.construct_block_blob(blockTemplateBuffer, nonceBuffer, blobTypeNum, ring);
}
module.exports = { blobTypeGrin, c29ProofSize, constructNewBlob, convertBlob, nonceSize, parseBlobType };
