"use strict";

const blockTemplate = require("node-blocktemplate");

function parseBlobType(blobTypeValue) {
    if (blobTypeValue === undefined || blobTypeValue === null) return 0;
    if (Number.isInteger(blobTypeValue)) return blobTypeValue;

    switch (blobTypeValue) {
    case "cryptonote": return 0;
    case "forknote1": return 1;
    case "forknote2": return 2;
    case "cryptonote2": return 3;
    case "cryptonote_ryo": return 4;
    case "cryptonote_loki": return 5;
    case "cryptonote3": return 6;
    case "aeon": return 7;
    case "cuckaroo": return 8;
    case "cryptonote_xtnc": return 9;
    case "cryptonote_tube": return 10;
    case "cryptonote_xhv": return 11;
    case "cryptonote_xta": return 12;
    case "cryptonote_zeph": return 13;
    case "cryptonote_xla": return 14;
    case "cryptonote_sal": return 15;
    case "cryptonote_arq": return 16;
    case "cryptonote_xeq": return 22;
    case "cryptonote_dero": return 100;
    case "raptoreum": return 104;
    case "raptoreum_kcn": return 105;
    case "xtm-t": return 106;
    default: return 0;
    }
}

function blobTypeGrin(blobTypeNum) {
    return blobTypeNum === 8 || blobTypeNum === 9 || blobTypeNum === 10 || blobTypeNum === 12;
}

function blobTypeDero(blobTypeNum) {
    return blobTypeNum === 100;
}

function blobTypeRtm(blobTypeNum) {
    return blobTypeNum === 104;
}

function blobTypeKcn(blobTypeNum) {
    return blobTypeNum === 105;
}

function blobTypeXtmT(blobTypeNum) {
    return blobTypeNum === 106;
}

function nonceSize(blobTypeNum) {
    return blobTypeNum === 7 ? 8 : 4;
}

function c29ProofSize(blobTypeNum) {
    switch (blobTypeNum) {
    case 10: return 40;
    case 12: return 48;
    default: return 32;
    }
}

function convertBlob(blobBuffer, blobTypeNum) {
    if (blobTypeDero(blobTypeNum) || blobTypeXtmT(blobTypeNum)) {
        return Buffer.from(blobBuffer);
    }
    if (blobTypeRtm(blobTypeNum)) {
        return blockTemplate.convertRtmBlob(blobBuffer);
    }
    if (blobTypeKcn(blobTypeNum)) {
        return blockTemplate.convertKcnBlob(blobBuffer);
    }
    return blockTemplate.convert_blob(blobBuffer, blobTypeNum);
}

function constructNewBlob(blockTemplateBuffer, nonceBuffer, blobTypeNum, ring) {
    if (blobTypeDero(blobTypeNum) || blobTypeXtmT(blobTypeNum)) {
        const newBlob = Buffer.alloc(blockTemplateBuffer.length);
        blockTemplateBuffer.copy(newBlob);
        nonceBuffer.copy(newBlob, 39, 0, 4);
        return newBlob;
    }
    if (blobTypeRtm(blobTypeNum)) {
        return blockTemplate.constructNewRtmBlob(blockTemplateBuffer, nonceBuffer);
    }
    if (blobTypeKcn(blobTypeNum)) {
        return blockTemplate.constructNewKcnBlob(blockTemplateBuffer, nonceBuffer);
    }
    return blockTemplate.construct_block_blob(blockTemplateBuffer, nonceBuffer, blobTypeNum, ring);
}

module.exports = {
    blobTypeGrin,
    c29ProofSize,
    constructNewBlob,
    convertBlob,
    nonceSize,
    parseBlobType
};
