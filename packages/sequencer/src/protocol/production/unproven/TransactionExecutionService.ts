/* eslint-disable max-lines */
import { inject, injectable, Lifecycle, scoped } from "tsyringe";
import {
  BlockProverExecutionData,
  BlockProverState,
  DefaultProvableHashList,
  NetworkState,
  Protocol,
  ProtocolModulesRecord,
  ProvableTransactionHook,
  RollupMerkleTree,
  RuntimeMethodExecutionContext,
  RuntimeMethodExecutionData,
  RuntimeProvableMethodExecutionResult,
  RuntimeTransaction,
  StateTransition,
  BundleTransactionPosition,
  BundleTransactionPositionType,
  ProvableBlockHook,
} from "@proto-kit/protocol";
import { Bool, Field, Poseidon } from "o1js";
import { AreProofsEnabled, log } from "@proto-kit/common";
import {
  MethodParameterDecoder,
  Runtime,
  RuntimeModule,
  RuntimeModulesRecord,
} from "@proto-kit/module";

import { PendingTransaction } from "../../../mempool/PendingTransaction";
import { CachedStateService } from "../../../state/state/CachedStateService";
import { distinctByString } from "../../../helpers/utils";
import { AsyncStateService } from "../../../state/async/AsyncStateService";
import { CachedMerkleTreeStore } from "../../../state/merkle/CachedMerkleTreeStore";
import type { StateRecord } from "../BlockProducerModule";

import { RuntimeMethodExecution } from "./RuntimeMethodExecution";

const errors = {
  methodIdNotFound: (methodId: string) =>
    new Error(`Can't find runtime method with id ${methodId}`),
};

export interface TransactionExecutionResult {
  tx: PendingTransaction;
  stateTransitions: StateTransition<unknown>[];
  protocolTransitions: StateTransition<unknown>[];
  status: Bool;
  statusMessage?: string;
  stateDiff: StateRecord;
}

export interface UnprovenBlock {
  networkState: NetworkState;
  transactions: TransactionExecutionResult[];
  transactionsHash: Field;
}

export interface UnprovenBlockMetadata {
  resultingStateRoot: bigint;
  resultingNetworkState: NetworkState;
}

@injectable()
@scoped(Lifecycle.ContainerScoped)
export class TransactionExecutionService {
  private readonly transactionHooks: ProvableTransactionHook<unknown>[];

  private readonly blockHooks: ProvableBlockHook<unknown>[];

  private readonly runtimeMethodExecution: RuntimeMethodExecution;

  public constructor(
    @inject("Runtime") private readonly runtime: Runtime<RuntimeModulesRecord>,
    @inject("Protocol")
    private readonly protocol: Protocol<ProtocolModulesRecord>
  ) {
    this.transactionHooks = protocol.dependencyContainer.resolveAll(
      "ProvableTransactionHook"
    );
    this.blockHooks =
      protocol.dependencyContainer.resolveAll("ProvableBlockHook");

    this.runtimeMethodExecution = new RuntimeMethodExecution(
      this.runtime,
      this.protocol,
      this.runtime.dependencyContainer.resolve(RuntimeMethodExecutionContext)
    );
  }

  private allKeys(stateTransitions: StateTransition<unknown>[]): Field[] {
    // We have to do the distinct with strings because
    // array.indexOf() doesn't work with fields
    return stateTransitions.map((st) => st.path).filter(distinctByString);
  }

  private decodeTransaction(tx: PendingTransaction): {
    method: (...args: unknown[]) => unknown;
    args: unknown[];
    module: RuntimeModule<unknown>;
  } {
    const methodDescriptors = this.runtime.methodIdResolver.getMethodNameFromId(
      tx.methodId.toBigInt()
    );

    const method = this.runtime.getMethodById(tx.methodId.toBigInt());

    if (methodDescriptors === undefined || method === undefined) {
      throw errors.methodIdNotFound(tx.methodId.toString());
    }

    const [moduleName, methodName] = methodDescriptors;
    const module: RuntimeModule<unknown> = this.runtime.resolve(moduleName);

    const parameterDecoder = MethodParameterDecoder.fromMethod(
      module,
      methodName
    );
    const args = parameterDecoder.fromFields(tx.args);

    return {
      method,
      args,
      module,
    };
  }

  private getAppChainForModule(
    module: RuntimeModule<unknown>
  ): AreProofsEnabled {
    if (module.runtime === undefined) {
      throw new Error("Runtime on RuntimeModule not set");
    }
    if (module.runtime.appChain === undefined) {
      throw new Error("AppChain on Runtime not set");
    }
    const { appChain } = module.runtime;
    return appChain;
  }

  private executeRuntimeMethod(
    method: (...args: unknown[]) => unknown,
    args: unknown[],
    contextInputs: RuntimeMethodExecutionData
  ): RuntimeProvableMethodExecutionResult {
    // Set up context
    const executionContext = this.runtime.dependencyContainer.resolve(
      RuntimeMethodExecutionContext
    );
    executionContext.setup(contextInputs);

    // Execute method
    method(...args);

    const runtimeResult = executionContext.current().result;

    // Clear executionContext
    executionContext.afterMethod();
    executionContext.clear();

    return runtimeResult;
  }

  private executeProtocolHooks(
    runtimeContextInputs: RuntimeMethodExecutionData,
    blockContextInputs: BlockProverExecutionData,
    runUnchecked = false
  ): RuntimeProvableMethodExecutionResult {
    // Set up context
    const executionContext = this.runtime.dependencyContainer.resolve(
      RuntimeMethodExecutionContext
    );
    executionContext.setup(runtimeContextInputs);
    if (runUnchecked) {
      executionContext.setSimulated(true);
    }

    this.transactionHooks.forEach((transactionHook) => {
      transactionHook.onTransaction(blockContextInputs);
    });

    const protocolResult = executionContext.current().result;
    executionContext.afterMethod();
    executionContext.clear();

    return protocolResult;
  }

  /**
   * Main entry point for creating a unproven block with everything
   * attached that is needed for tracing
   */
  public async createUnprovenBlock(
    stateService: CachedStateService,
    transactions: PendingTransaction[],
    metadata: UnprovenBlockMetadata
  ): Promise<UnprovenBlock> {
    const executionResults: TransactionExecutionResult[] = [];

    const transactionsHashList = new DefaultProvableHashList(Field);

    const networkState = this.blockHooks.reduce<NetworkState>(
      (state, hook) =>
        hook.beforeBundle({
          networkState: metadata.resultingNetworkState,

          state: {
            stateRoot: Field(metadata.resultingStateRoot),
            networkStateHash: metadata.resultingNetworkState.hash(),
            transactionsHash: Field(0),
          },
        }),
      new NetworkState(metadata.resultingNetworkState)
    );

    for (const [index, tx] of transactions.entries()) {
      try {
        // Determine position in bundle (first, middle, last)
        const transactionPosition =
          BundleTransactionPosition.positionTypeFromIndex(
            index,
            transactions.length
          );

        // Create execution trace
        // eslint-disable-next-line no-await-in-loop
        const executionTrace = await this.createExecutionTrace(
          stateService,
          tx,
          networkState,
          transactionPosition
        );

        // Push result to results and transaction onto bundle-hash
        executionResults.push(executionTrace);
        transactionsHashList.push(tx.hash());
      } catch (error) {
        if (error instanceof Error) {
          log.error("Error in inclusion of tx, skipping", error);
        }
      }
    }

    return {
      transactions: executionResults,
      networkState,
      transactionsHash: transactionsHashList.commitment,
    };
  }

  public async generateMetadataForNextBlock(
    block: UnprovenBlock,
    merkleTreeStore: CachedMerkleTreeStore,
    modifyTreeStore = true
  ): Promise<UnprovenBlockMetadata> {
    // Flatten diff list into a single diff by applying them over each other
    const combinedDiff = block.transactions
      .map((tx) => tx.stateDiff)
      .reduce<StateRecord>((accumulator, diff) => {
        // accumulator properties will be overwritten by diff's values
        return Object.assign(accumulator, diff);
      }, {});

    // If we modify the parent store, we use it, otherwise we abstract over it.
    const inMemoryStore = modifyTreeStore
      ? merkleTreeStore
      : new CachedMerkleTreeStore(merkleTreeStore);
    const tree = new RollupMerkleTree(inMemoryStore);

    for (const key of Object.keys(combinedDiff)) {
      // eslint-disable-next-line no-await-in-loop
      await inMemoryStore.preloadKey(BigInt(key));
    }

    Object.entries(combinedDiff).forEach(([key, state]) => {
      const treeValue = state !== undefined ? Poseidon.hash(state) : Field(0);
      tree.setLeaf(BigInt(key), treeValue);
    });

    const stateRoot = tree.getRoot();

    const state: BlockProverState = {
      stateRoot,
      transactionsHash: block.transactionsHash,
      networkStateHash: block.networkState.hash(),
    };

    const resultingNetworkState = this.blockHooks.reduce<NetworkState>(
      (networkState, hook) =>
        hook.afterBundle({
          state,
          networkState,
        }),
      block.networkState
    );

    return {
      resultingNetworkState,
      resultingStateRoot: stateRoot.toBigInt(),
    };
  }

  private collectStateDiff(
    stateService: CachedStateService,
    stateTransitions: StateTransition<unknown>[]
  ): StateRecord {
    const keys = this.allKeys(stateTransitions);

    return keys.reduce<Record<string, Field[] | undefined>>((state, key) => {
      state[key.toString()] = stateService.get(key);
      return state;
    }, {});
  }

  private async applyTransitions(
    stateService: CachedStateService,
    stateTransitions: StateTransition<unknown>[]
  ): Promise<void> {
    await Promise.all(
      // Use updated stateTransitions since only they will have the
      // right values
      stateTransitions
        .filter((st) => st.to.isSome.toBoolean())
        .map(async (st) => {
          await stateService.setAsync(st.path, st.to.toFields());
        })
    );
  }

  // eslint-disable-next-line no-warning-comments
  // TODO Here exists a edge-case, where the protocol hooks set
  // some state that is then consumed by the runtime and used as a key.
  // In this case, runtime would generate a wrong key here.
  private async extractAccessedKeys(
    method: (...args: unknown[]) => unknown,
    args: unknown[],
    runtimeContextInputs: RuntimeMethodExecutionData,
    blockContextInputs: BlockProverExecutionData,
    parentStateService: AsyncStateService
  ): Promise<{
    runtimeKeys: Field[];
    protocolKeys: Field[];
  }> {
    // eslint-disable-next-line no-warning-comments
    // TODO unsafe to re-use params here?
    const stateTransitions =
      await this.runtimeMethodExecution.simulateMultiRound(
        () => {
          method(...args);
        },
        runtimeContextInputs,
        parentStateService
      );

    const protocolTransitions =
      await this.runtimeMethodExecution.simulateMultiRound(
        () => {
          this.transactionHooks.forEach((transactionHook) => {
            transactionHook.onTransaction(blockContextInputs);
          });
        },
        runtimeContextInputs,
        parentStateService
      );

    log.debug(`Got ${stateTransitions.length} StateTransitions`);
    log.debug(`Got ${protocolTransitions.length} ProtocolStateTransitions`);

    return {
      runtimeKeys: this.allKeys(stateTransitions),
      protocolKeys: this.allKeys(protocolTransitions),
    };
  }

  // eslint-disable-next-line max-statements
  private async createExecutionTrace(
    stateService: CachedStateService,
    tx: PendingTransaction,
    networkState: NetworkState,
    transactionPosition: BundleTransactionPositionType
  ): Promise<TransactionExecutionResult> {
    const { method, args, module } = this.decodeTransaction(tx);

    // Disable proof generation for tracing
    const appChain = this.getAppChainForModule(module);
    const previousProofsEnabled = appChain.areProofsEnabled;
    appChain.setProofsEnabled(false);

    const blockContextInputs: BlockProverExecutionData = {
      transaction: tx.toProtocolTransaction(),
      networkState,

      bundleTransactionPosition:
        BundleTransactionPosition.fromPositionType(transactionPosition),
    };
    const runtimeContextInputs = {
      networkState,

      transaction: RuntimeTransaction.fromProtocolTransaction(
        blockContextInputs.transaction
      ),
    };

    const { runtimeKeys, protocolKeys } = await this.extractAccessedKeys(
      method,
      args,
      runtimeContextInputs,
      blockContextInputs,
      stateService
    );

    // Preload keys
    await stateService.preloadKeys(
      runtimeKeys.concat(protocolKeys).filter(distinctByString)
    );

    // Execute second time with preloaded state. The following steps
    // generate and apply the correct STs with the right values
    this.runtime.stateServiceProvider.setCurrentStateService(stateService);
    this.protocol.stateServiceProvider.setCurrentStateService(stateService);

    const protocolResult = this.executeProtocolHooks(
      runtimeContextInputs,
      blockContextInputs
    );

    if (!protocolResult.status.toBoolean()) {
      throw new Error(
        `Protocol hooks not executable: ${
          protocolResult.statusMessage ?? "unknown"
        }`
      );
    }

    log.debug(
      "PSTs:",
      protocolResult.stateTransitions.map((x) => x.toJSON())
    );

    // Apply protocol STs
    await this.applyTransitions(stateService, protocolResult.stateTransitions);

    let stateDiff = this.collectStateDiff(
      stateService,
      protocolResult.stateTransitions
    );

    const runtimeResult = this.executeRuntimeMethod(
      method,
      args,
      runtimeContextInputs
    );

    log.debug(
      "STs:",
      runtimeResult.stateTransitions.map((x) => x.toJSON())
    );

    // Apply runtime STs (only if the tx succeeded)
    if (runtimeResult.status.toBoolean()) {
      await this.applyTransitions(stateService, runtimeResult.stateTransitions);

      stateDiff = this.collectStateDiff(
        stateService,
        protocolResult.stateTransitions.concat(runtimeResult.stateTransitions)
      );
    }

    // Reset global stateservice
    this.runtime.stateServiceProvider.popCurrentStateService();
    this.protocol.stateServiceProvider.popCurrentStateService();
    // Reset proofs enabled
    appChain.setProofsEnabled(previousProofsEnabled);

    return {
      tx,
      stateTransitions: runtimeResult.stateTransitions,
      protocolTransitions: protocolResult.stateTransitions,
      status: runtimeResult.status,
      statusMessage: runtimeResult.statusMessage,

      stateDiff,
    };
  }
}