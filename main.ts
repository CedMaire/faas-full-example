import { deepStrictEqual } from "node:assert/strict";
import { RPCClient, SigHashType, TransactionInput, TransactionOutput } from "rpc-bitcoin";
import { Faas, ASSET_BTC, PAIR_BTC_USD, PSBT, PSBTNI } from "@frictionless-money/faas";

// Parameters of your Bitcoin Core testnet node.
const NODE_URL: String = "http://127.0.0.1";
const NODE_PORT: Number = 18332;
const NODE_TIMEOUT: Number = 10000;
const NODE_USER: String = "???";
const NODE_PASS: String = "???";

const NODE_CLIENT: RPCClient = new RPCClient({
    url: NODE_URL.toString(),
    port: NODE_PORT.valueOf(),
    timeout: NODE_TIMEOUT.valueOf(),
    user: NODE_USER.toString(),
    pass: NODE_PASS.toString(),
});

// Bitcoin address where we will send our own funds back.
const OUTPUT_ADDRESS: String = "???";
// Bitcoin Core label of the wallet that is able to spend the funds.
const WALLET_LABEL: String = "???";

// Frictionless GraphQL API endpoint.
const FAAS_URL: String = "https://graphql.frictionless.money/";
// Frictionless account API key.
const FAAS_KEY: String = "???";

enum UserChoice {
    Basic = "basic",
    PSBT = "psbt",
    PSBTNI = "psbtni",
};

/**
 * Queries the Bitcoin Core testnet node for unspent UTXOs. It will
 * select the first one and build a PSBT sending the full amount to
 * the address defined above. It will optionnally sign it with the
 * selected SIG_HASH type. The returned PSBT does not allocate any
 * miner fees.
 *
 * @param sign
 * @param sighashtype
 * @returns a Base64 encoded PSBT.
 */
async function getPSBT(sign: Boolean, sighashtype: SigHashType = "ALL"): Promise<String> {
    const unspentUTXOs: Array<any> = await NODE_CLIENT.listunspent({
        minconf: 0,
        addresses: [OUTPUT_ADDRESS.toString()],
    },
        WALLET_LABEL.toString()
    );

    const txid: String = unspentUTXOs[0].txid;
    const vout: Number = unspentUTXOs[0].vout;
    const amount: Number = unspentUTXOs[0].amount;

    const inputs: TransactionInput[] = [
        {
            txid: txid.toString(),
            vout: vout.valueOf(),
        },
    ];

    const outputs: TransactionOutput[] = [
        {
            [OUTPUT_ADDRESS.toString()]: amount.valueOf(),
        }
    ];

    const customerPSBT: String = await NODE_CLIENT.createpsbt({
        inputs,
        outputs,
        locktime: 0,
        replaceable: true,
    });

    const processedCustomerPSBT = await NODE_CLIENT.walletprocesspsbt({
        psbt: customerPSBT.toString(),
        sign: sign.valueOf(),
        sighashtype,
        bip32derivs: true,
    },
        WALLET_LABEL.toString()
    );

    return processedCustomerPSBT.psbt as String;
}

/**
 * Queries the Bitcoin Core testnet node and process the Base64
 * encoded PSBT. It will optionnally sign it with the selected
 * SIG_HASH type.
 *
 * @param psbt
 * @param sign
 * @param sighashtype
 * @returns a Base64 encoded PSBT.
 */
async function processPSBT(psbt: String, sign: Boolean, sighashtype: SigHashType = "ALL"): Promise<String> {
    const processedPSBT = await NODE_CLIENT.walletprocesspsbt({
        psbt: psbt.toString(),
        sign: sign.valueOf(),
        sighashtype,
        bip32derivs: true,
    },
        WALLET_LABEL.toString()
    );

    return processedPSBT.psbt as String;
}

/**
 * FaaS in Interactive Mode (PSBT)
 *
 * A customer may build a zero-fee candidate PSBT (un-signed) and
 * submit it to Frictionless. Frictionless will add fees and send
 * that modified PSBT back to the customer. The customer may now
 * verify that none of their own INPUTs and OUTPUTs have been
 * tampered with. Once satisfied, the customer may sign their own
 * INPUTs with the `ALL` SIG_HASH-type and submit it again to
 * Frictionless. Frictionless will sign their own INPUTs and
 * broadcast the final TX.
 *
 * @param faas
 */
async function psbt(faas: Faas): Promise<void> {
    console.log("Starting FaaS in Interactive Mode (PSBT)");
    await getPSBT(false).then(async (originalPSBT: String) => {
        console.log("   ", "Submitting Candidate TX");
        const feeIncludedPSBT: PSBT = await faas.createPSBT(ASSET_BTC, originalPSBT.toString());
        console.log("   ", "Retrieving Candidate TX");
        let readPSBT: PSBT = await faas.readPSBT(feeIncludedPSBT.asset, feeIncludedPSBT.id);

        console.log("   ", "Testing TX Equality");
        deepStrictEqual(readPSBT, feeIncludedPSBT);

        /**
         * Customers must now verify that none of their own INPUTs
         * and OUTPUTs have been tampered with.
         */

        console.log("   ", "Signing TX with Added Fees");
        const signedPSBT: String = await processPSBT(feeIncludedPSBT.psbt, true, "ALL");

        console.log("   ", "Submitting Customer-Signed TX");
        const broadcastPSBT: PSBT = await faas.updatePSBT(ASSET_BTC, feeIncludedPSBT.id, signedPSBT.toString());
        console.log("   ", "Retrieving Final TX");
        readPSBT = await faas.readPSBT(broadcastPSBT.asset, broadcastPSBT.id);

        console.log("   ", "Testing TX Equality");
        deepStrictEqual(readPSBT, broadcastPSBT);
    }).catch((e: Error) => {
        console.error("PSBT failed:", e.message);
    });
}

/**
 * FaaS in Non-Interactive Mode (PSBTNI)
 *
 * A customer may build a zero-fee PSBT, sign it with
 * the `ALL|ANYONECANPAY` SIG_HASH-type, and then submit
 * it to Frictionless. Frictionless will add fees and
 * broadcast the final TX.
 *
 * @param faas
 */
async function psbtni(faas: Faas): Promise<void> {
    console.log("Starting FaaS in Non-Interactive Mode (PSBTNI)");
    await getPSBT(true, "ALL|ANYONECANPAY").then(async (signedPSBTNI: String) => {
        console.log("   ", "Submitting Pre-Signed TX (ALL|ANYONECANPAY)");
        const broadcastPSBTNI: PSBTNI = await faas.createPSBTNI(ASSET_BTC, signedPSBTNI.toString());
        console.log("   ", "Retrieving TX");
        const readPSBTNI: PSBTNI = await faas.readPSBTNI(broadcastPSBTNI.asset, broadcastPSBTNI.id);

        console.log("   ", "Testing TX Equality");
        deepStrictEqual(readPSBTNI, broadcastPSBTNI);
    }).catch((e: Error) => {
        console.error("PSBTNI failed:", e.message);
    });
}

/**
 * Showcases the functionalities of the FaaS library depending on
 * the users choice.
 *
 * @param choice
 */
async function run(choice: UserChoice): Promise<void> {
    if (!Object.values(UserChoice).includes(choice)) {
        throw new Error("Invalid user choice.");
    }

    const faas: Faas = new Faas(FAAS_URL.toString(), FAAS_KEY.toString());

    // Basics

    deepStrictEqual(faas.url() as String, FAAS_URL);
    deepStrictEqual(faas.key() as String, FAAS_KEY);

    deepStrictEqual(await faas.readApiKey() as String, FAAS_KEY);

    const myCredit: Number = await faas.readCredit();
    console.log("Available Credit          :", myCredit);

    const currentBitcoinFee: Number = await faas.readFee(ASSET_BTC);
    console.log("Current BTC Fee (s/vB)    :", currentBitcoinFee);

    const currentBitcoinRate: Number = await faas.readRate(PAIR_BTC_USD);
    console.log("Current BTC Rate (USD/BTC):", currentBitcoinRate);

    // PSBT

    if (choice === "psbt") {
        await psbt(faas);
    }

    const readPSBTs: PSBT[] = await faas.readPSBTs();
    console.log("PSBTs");
    readPSBTs.forEach((psbt, i) => {
        console.log(i, " ", psbt.asset, ":", psbt.id, ":", psbt.state);
        console.log("   ", psbt.txid);
    });

    // PSBTNI

    if (choice === "psbtni") {
        await psbtni(faas);
    }

    const readPSBTNIs: PSBTNI[] = await faas.readPSBTNIs();
    console.log("PSBTNIs");
    readPSBTNIs.forEach((psbtni, i) => {
        console.log(i, " ", psbtni.asset, ":", psbtni.id, ":", psbtni.state);
        console.log("   ", psbtni.txid);
    });
}

run(process.argv.slice()[2] as UserChoice)
    .then(() => console.log("Done."))
    .catch((e: Error) => console.log(e.message));
