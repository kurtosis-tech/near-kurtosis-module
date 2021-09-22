import { NetworkContext, ServiceID, ContainerCreationConfig, ContainerCreationConfigBuilder, ContainerRunConfig, ContainerRunConfigBuilder, StaticFileID, ServiceContext, PortBinding } from "kurtosis-core-api-lib";
import { KurtosisLambda } from "kurtosis-lambda-api-lib";
import { Result, ok, err } from "neverthrow";
import * as log from "loglevel";
import { addContractHelperDb, ContractHelperDbInfo } from "./services/contract_helper_db";
import { DOCKER_PORT_PROTOCOL_SEPARATOR, getPortNumFromHostMachinePortBinding, TCP_PROTOCOL, tryToFormHostMachineUrl } from "./consts";
import { addNearupService, NearupInfo } from "./services/nearup";
import { addContractHelperService, ContractHelperServiceInfo } from "./services/contract_helper";
import { addWallet, WalletInfo } from "./services/wallet";
import { addIndexer, IndexerInfo } from "./services/indexer";


export type ContainerRunConfigSupplier = (ipAddr: string, generatedFileFilepaths: Map<string, string>, staticFileFilepaths: Map<StaticFileID, string>) => Result<ContainerRunConfig, Error>;

const WAMP_BACKEND_SECRET: string = "back";


// Explorer WAMP
const EXPLORER_WAMP_SERVICE_ID: ServiceID = "wamp";
const EXPLORER_WAMP_IMAGE: string = "near-explorer_wamp";
const EXPLORER_WAMP_PORT_NUM: number = 8080;
const EXPLORER_WAMP_DOCKER_PORT_DESC: string = EXPLORER_WAMP_PORT_NUM.toString() + DOCKER_PORT_PROTOCOL_SEPARATOR + TCP_PROTOCOL;
const EXPLORER_WAMP_STATIC_ENVVARS: Map<string, string> = new Map(Object.entries({
    "WAMP_NEAR_EXPLORER_PORT": EXPLORER_WAMP_PORT_NUM.toString(),
    "WAMP_NEAR_EXPLORER_BACKEND_SECRET": WAMP_BACKEND_SECRET,
}));

// Explorer Backend
const EXPLORER_BACKEND_SERVICE_ID: ServiceID = "backend";
const EXPLORER_BACKEND_IMAGE: string = "near-explorer_backend";
const EXPLORER_BACKEND_STATIC_ENVVARS: Map<string, string> = new Map(Object.entries({
    "WAMP_NEAR_EXPLORER_URL": "ws://" + EXPLORER_WAMP_SERVICE_ID + ":" + EXPLORER_WAMP_PORT_NUM + "/ws",
    "WAMP_NEAR_EXPLORER_BACKEND_SECRET": WAMP_BACKEND_SECRET,
}));
const EXPLORER_BACKEND_ENTRYPOINT_ARGS: string[] = [
    "npm", 
    "run", 
    "start:testnet-with-indexer"
];
// TODO Mem limit??

// Explorer Frontend
const EXPLORER_FRONTEND_SERVICE_ID: ServiceID = "frontend";
const EXPLORER_FRONTEND_IMAGE: string = "near-explorer_frontend";
const EXPLORER_FRONTEND_PORT_NUM: number = 3000;
const EXPLORER_FRONTEND_DOCKER_PORT_DESC: string = EXPLORER_FRONTEND_PORT_NUM.toString() + DOCKER_PORT_PROTOCOL_SEPARATOR + TCP_PROTOCOL;
const EXPLORER_FRONTEND_STATIC_ENVVARS: Map<string, string> = new Map(Object.entries({
    "PORT": EXPLORER_FRONTEND_PORT_NUM.toString(),
    "NEAR_EXPLORER_DATA_SOURCE": "INDEXER_BACKEND",
    // It's not clear what this value does - it's pulled as-is from https://github.com/near/near-explorer/blob/master/frontend/package.json#L31
    "NEAR_NETWORKS": "[{\"name\": \"testnet\", \"explorerLink\": \"http://localhost:3000/\", \"aliases\": [\"localhost:3000\", \"127.0.0.1:3000\"], \"nearWalletProfilePrefix\": \"https://wallet.testnet.near.org/profile\"}]",
    "WAMP_NEAR_EXPLORER_INTERNAL_URL": "ws://" + EXPLORER_WAMP_SERVICE_ID + ":" + EXPLORER_WAMP_PORT_NUM + "/ws",
}));
const EXPLORER_FRONTEND_WAMP_EXTERNAL_URL_ENVVAR: string = "WAMP_NEAR_EXPLORER_URL";

class NearLambdaResult {
    // When Kurtosis is in debug mode, the explorer frontend's port will be bound to a port on the user's machine so they can access the frontend
    //  even though the frontend is running inside Docker. When Kurtosis is not in debug mode, this will be null.
    private readonly maybeHostMachineExplorerUrl: string | null;

    // Same thing - when debug mode is enabled, the nearup container will be bound to a port on the user's host machine
    private readonly maybeHostMachineNearNodeUrl: string | null;

    private readonly maybeHostMachineContractHelperUrl: string | null;

    private readonly maybeHostMachineWalletUrl: string | null;

    constructor(
        maybeHostMachineExplorerUrl: string | null, 
        maybeHostMachineNearNodeUrl: string | null,
        maybeHostMachineContractHelperUrl: string | null,
        maybeHostMachineWalletUrl: string | null,
    ) {
        this.maybeHostMachineExplorerUrl = maybeHostMachineExplorerUrl;
        this.maybeHostMachineNearNodeUrl = maybeHostMachineNearNodeUrl;
        this.maybeHostMachineContractHelperUrl = maybeHostMachineContractHelperUrl;
        this.maybeHostMachineWalletUrl = maybeHostMachineWalletUrl;
    }
}

export class NearLambda implements KurtosisLambda {
    constructor() {}

    // All this logic comes from translating https://github.com/near/docs/blob/975642ad49338bf8728a675def1f8bec8a780922/docs/local-setup/entire-setup.md
    //  into Kurtosis-compatible code
    async execute(networkCtx: NetworkContext, serializedParams: string): Promise<Result<string, Error>> {
        log.info("Near Lambda receives serializedParams '" + serializedParams + "'");
        let args: ExecuteArgs;
        try {
            args = JSON.parse(serializedParams)
        } catch (e: any) {
            // Sadly, we have to do this because there's no great way to enforce the caught thing being an error
            // See: https://stackoverflow.com/questions/30469261/checking-for-typeof-error-in-js
            if (e && e.stack && e.message) {
                return err(e as Error);
            }
            return err(new Error("Parsing params string '" + serializedParams + "' threw an exception, but " +
                "it's not an Error so we can't report any more information than this"));
        }

        // TODO handle custom params here
        const addContractHelperDbServiceResult: Result<ContractHelperDbInfo, Error> = await addContractHelperDb(networkCtx)
        if (addContractHelperDbServiceResult.isErr()) {
            return err(addContractHelperDbServiceResult.error);
        }
        const contractHelperDbInfo: ContractHelperDbInfo = addContractHelperDbServiceResult.value;

        const addIndexerResult: Result<IndexerInfo, Error> = await addIndexer(
            networkCtx,
            contractHelperDbInfo.getNetworkInternalHostname(),
            contractHelperDbInfo.getNetworkInternalPortNum(),
            contractHelperDbInfo.getDbUsername(),
            contractHelperDbInfo.getDbPassword(),
            contractHelperDbInfo.getIndexerDb()
        );
        if (addIndexerResult.isErr()) {
            return err(addIndexerResult.error);
        }
        const indexerInfo: IndexerInfo = addIndexerResult.value;

        /*
        const addNearupServiceResult: Result<NearupInfo, Error> = await addNearupService(networkCtx)
        if (addNearupServiceResult.isErr()) {
            return err(addNearupServiceResult.error);
        }
        const nearupInfo: NearupInfo = addNearupServiceResult.value;
        */

        const addContractHelperServiceResult: Result<ContractHelperServiceInfo, Error> = await addContractHelperService(
            networkCtx,
            contractHelperDbInfo.getNetworkInternalHostname(),
            contractHelperDbInfo.getNetworkInternalPortNum(),
            contractHelperDbInfo.getDbUsername(),
            contractHelperDbInfo.getDbPassword(),
            contractHelperDbInfo.getIndexerDb(),
            indexerInfo.getNetworkInternalHostname(),
            indexerInfo.getNetworkInternalPortNum(),
            indexerInfo.getValidatorKey()
        );
        if (addContractHelperServiceResult.isErr()) {
            return err(addContractHelperServiceResult.error);
        }
        const contractHelperServiceInfo: ContractHelperServiceInfo = addContractHelperServiceResult.value;

        const addWalletResult: Result<WalletInfo, Error> = await addWallet(
            networkCtx,
            indexerInfo.getMaybeHostMachineUrl(),
            contractHelperServiceInfo.getMaybeHostMachineUrl(),
            undefined, // TODO TODO TODO FIX THIS!!!
        );
        if (addWalletResult.isErr()) {
            return err(addWalletResult.error);
        }
        const walletInfo: WalletInfo = addWalletResult.value;

        // TODO UNCOMMENT WHEN NEARCORE IS WORKING
        /*
        const addWampServiceResult: Result<[ServiceContext, Map<string, PortBinding>], Error> = await NearLambda.addWampService(networkCtx)
        if (addWampServiceResult.isErr()) {
            return err(addWampServiceResult.error);
        }
        const [wampServiceCtx, wampHostPortBindings] = addWampServiceResult.value;
        const wampHostMachinePortBindingOpt: PortBinding | undefined = wampHostPortBindings.get(EXPLORER_WAMP_DOCKER_PORT_DESC);

        const addBackendServiceResult: Result<[ServiceContext, Map<string, PortBinding>], Error> = await NearLambda.addBackendService(networkCtx)
        if (addBackendServiceResult.isErr()) {
            return err(addBackendServiceResult.error);
        }
        const [backendServiceCtx, backendHostPortBindings] = addBackendServiceResult.value;

        const addFrontendServiceResult: Result<[ServiceContext, Map<string, PortBinding>], Error> = await NearLambda.addFrontendService(networkCtx, wampHostMachinePortBindingOpt)
        if (addFrontendServiceResult.isErr()) {
            return err(addFrontendServiceResult.error);
        }
        const [frontendServiceCtx, frontendHostPortBindings] = addFrontendServiceResult.value;
        const formFrontendUrlResult: Result<string | null, Error> = NearLambda.tryToFormHostMachineUrl(
            EXPLORER_FRONTEND_DOCKER_PORT_DESC, 
            frontendHostPortBindings,
            (ipAddr: string, portNum: number) => "http://" + ipAddr + ":" + portNum.toString()
        );
        if (formFrontendUrlResult.isErr()) {
            return err(formFrontendUrlResult.error);
        }
        const frontendUrl: string | null = formFrontendUrlResult.value;
        */
        const frontendUrl: string | null = null;



        const nearLambdaResult: NearLambdaResult = new NearLambdaResult(
            frontendUrl,
            indexerInfo.getMaybeHostMachineUrl() || null,
            contractHelperServiceInfo.getMaybeHostMachineUrl() || null,
            walletInfo.getMaybeHostMachineUrl() || null,
        );

        let stringResult;
        try {
            stringResult = JSON.stringify(nearLambdaResult);
        } catch (e: any) {
            // Sadly, we have to do this because there's no great way to enforce the caught thing being an error
            // See: https://stackoverflow.com/questions/30469261/checking-for-typeof-error-in-js
            if (e && e.stack && e.message) {
                return err(e as Error);
            }
            return err(new Error("An error occurred serializing the Kurtosis Lambda result threw an exception, but " +
                "it's not an Error so we can't report any more information than this"));
        }

        log.info("Near Lambda executed successfully")
        return ok(stringResult);
    }

    // ====================================================================================================
    //                                       Private helper functions
    // ====================================================================================================


    private static async addWampService(networkCtx: NetworkContext): Promise<Result<[ServiceContext, Map<string, PortBinding>], Error>> {
        const usedPortsSet: Set<string> = new Set();
        usedPortsSet.add(EXPLORER_WAMP_DOCKER_PORT_DESC)
        const containerCreationConfig: ContainerCreationConfig = new ContainerCreationConfigBuilder(
            EXPLORER_WAMP_IMAGE,
        ).withUsedPorts(
            usedPortsSet,
        ).build();

        const envVars: Map<string, string> = new Map(EXPLORER_WAMP_STATIC_ENVVARS);
        const containerRunConfigSupplier: ContainerRunConfigSupplier = (ipAddr: string, generatedFileFilepaths: Map<string, string>, staticFileFilepaths: Map<StaticFileID, string>) => {
            const result: ContainerRunConfig = new ContainerRunConfigBuilder().withEnvironmentVariableOverrides(
                envVars
            ).build();
            return ok(result);
        }
        
        const addServiceResult: Result<[ServiceContext, Map<string, PortBinding>], Error> = await networkCtx.addService(EXPLORER_WAMP_SERVICE_ID, containerCreationConfig, containerRunConfigSupplier);
        if (addServiceResult.isErr()) {
            return err(addServiceResult.error);
        }
        return ok(addServiceResult.value);
    }



    private static async addBackendService(networkCtx: NetworkContext): Promise<Result<[ServiceContext, Map<string, PortBinding>], Error>> {
        const containerCreationConfig: ContainerCreationConfig = new ContainerCreationConfigBuilder(
            EXPLORER_BACKEND_IMAGE,
        ).build();

        const envVars: Map<string, string> = new Map(EXPLORER_BACKEND_STATIC_ENVVARS);
        const containerRunConfigSupplier: ContainerRunConfigSupplier = (ipAddr: string, generatedFileFilepaths: Map<string, string>, staticFileFilepaths: Map<StaticFileID, string>) => {
            const result: ContainerRunConfig = new ContainerRunConfigBuilder().withEnvironmentVariableOverrides(
                envVars
            ).withEntrypointOverride(
                EXPLORER_BACKEND_ENTRYPOINT_ARGS
            ).build();
            return ok(result);
        }
        
        const addServiceResult: Result<[ServiceContext, Map<string, PortBinding>], Error> = await networkCtx.addService(EXPLORER_BACKEND_SERVICE_ID, containerCreationConfig, containerRunConfigSupplier);
        if (addServiceResult.isErr()) {
            return err(addServiceResult.error);
        }
        return ok(addServiceResult.value);
    }

    private static async addFrontendService(networkCtx: NetworkContext, wampHostMachinePortBindingOpt?: PortBinding): Promise<Result<[ServiceContext, Map<string, PortBinding>], Error>> {
        const usedPortsSet: Set<string> = new Set();
        usedPortsSet.add(EXPLORER_FRONTEND_DOCKER_PORT_DESC)
        const containerCreationConfig: ContainerCreationConfig = new ContainerCreationConfigBuilder(
            EXPLORER_FRONTEND_IMAGE,
        ).withUsedPorts(
            usedPortsSet,
        ).build();


        const envVars: Map<string, string> = new Map(EXPLORER_FRONTEND_STATIC_ENVVARS);
        // If there's no host machine WAMP port (i.e. Kurtosis isn't running in debug mode) then we can't set the WAMP Docker-external variable
        if (wampHostMachinePortBindingOpt !== undefined) {
            const wampHostMachinePortNumResult: Result<number, Error> = getPortNumFromHostMachinePortBinding(wampHostMachinePortBindingOpt);
            if (wampHostMachinePortNumResult.isErr()) {
                return err(wampHostMachinePortNumResult.error);
            }
            const wampHostMachinePortNum: number = wampHostMachinePortNumResult.value;
            const wampHostMachineInterfaceIp: string = wampHostMachinePortBindingOpt.getInterfaceIp();
            envVars.set(EXPLORER_FRONTEND_WAMP_EXTERNAL_URL_ENVVAR, "ws://" + wampHostMachineInterfaceIp + ":" + wampHostMachinePortNum.toString() + "/ws");  // This is the WS port on the user's local machine, which we'll only know when we start the WAMP service
        }
        const containerRunConfigSupplier: ContainerRunConfigSupplier = (ipAddr: string, generatedFileFilepaths: Map<string, string>, staticFileFilepaths: Map<StaticFileID, string>) => {
            const result: ContainerRunConfig = new ContainerRunConfigBuilder().withEnvironmentVariableOverrides(
                envVars
            ).build();
            return ok(result);
        }
        
        const addServiceResult: Result<[ServiceContext, Map<string, PortBinding>], Error> = await networkCtx.addService(EXPLORER_FRONTEND_SERVICE_ID, containerCreationConfig, containerRunConfigSupplier);
        if (addServiceResult.isErr()) {
            return err(addServiceResult.error);
        }
        return ok(addServiceResult.value);
    }

}