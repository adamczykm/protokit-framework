import {
  RuntimeMethodExecutionContext,
  RuntimeMethodExecutionData,
  StateTransition,
  ProtocolEnvironment,
} from "@proto-kit/protocol";
import { RuntimeEnvironment } from "@proto-kit/module";
import _ from "lodash";
import { Field } from "o1js";

import { AsyncStateService } from "../../../state/async/AsyncStateService";
import { CachedStateService } from "../../../state/state/CachedStateService";
import { distinctByString } from "../../../helpers/utils";

export class RuntimeMethodExecution {
  public constructor(
    private readonly runtime: RuntimeEnvironment,
    private readonly protocol: ProtocolEnvironment,
    private readonly executionContext: RuntimeMethodExecutionContext
  ) {}

  private async executeMethodWithKeys(
    touchedKeys: string[],
    method: () => void,
    contextInputs: RuntimeMethodExecutionData,
    parentStateService: AsyncStateService
  ): Promise<StateTransition<unknown>[]> {
    const { executionContext, runtime, protocol } = this;

    executionContext.setup(contextInputs);
    executionContext.setSimulated(true);

    const stateService = new CachedStateService(parentStateService);
    runtime.stateServiceProvider.setCurrentStateService(stateService);
    protocol.stateServiceProvider.setCurrentStateService(stateService);

    // Preload previously determined keys
    await stateService.preloadKeys(
      touchedKeys.map((fieldString) => Field(fieldString))
    );

    // Execute method
    method();

    const { stateTransitions } = executionContext.current().result;

    // Clear executionContext
    executionContext.afterMethod();
    executionContext.clear();

    runtime.stateServiceProvider.popCurrentStateService();
    protocol.stateServiceProvider.popCurrentStateService();

    return stateTransitions;
  }

  /**
   * Simulates a certain Context-aware method through multiple rounds.
   *
   * For a method that emits n Statetransitions, we execute it n times,
   * where for every i-th iteration, we collect the i-th ST that has
   * been emitted and preload the corresponding key.
   */
  public async simulateMultiRound(
    method: () => void,
    contextInputs: RuntimeMethodExecutionData,
    parentStateService: AsyncStateService
  ): Promise<StateTransition<unknown>[]> {
    let numberMethodSTs: number | undefined;
    let collectedSTs = 0;

    const touchedKeys: string[] = [];

    let lastRuntimeResult: StateTransition<unknown>[];

    do {
      // eslint-disable-next-line no-await-in-loop
      const stateTransitions = await this.executeMethodWithKeys(
        touchedKeys,
        method,
        contextInputs,
        parentStateService
      );

      if (numberMethodSTs === undefined) {
        numberMethodSTs = stateTransitions.length;
      }

      if (collectedSTs === 0) {
        // Do a full run with all keys and see if keys have changed
        // (i.e. if no dynamic keys are used, just take that result)
        // If that is the case, fast-forward to the first dynamic key
        const keys = stateTransitions
          .map((st) => st.path.toString())
          .filter(distinctByString);
        const stateTransitionsFullRun = await this.executeMethodWithKeys(
          keys,
          method,
          contextInputs,
          parentStateService
        );

        const firstDiffIndex = _.zip(
          stateTransitions,
          stateTransitionsFullRun
        ).findIndex(
          ([st1, st2]) => st1?.path.toString() !== st2?.path.toString()
        );

        if (firstDiffIndex === -1) {
          // Abort bcs no dynamic keys are used => use then 1:1
          return stateTransitionsFullRun;
        } else {
          // here push all known keys up to the first dynamic key
          // touchedkeys is empty, so we don't care about that
          const additionalKeys = stateTransitionsFullRun
            .slice(0, firstDiffIndex)
            .map((st) => st.path.toString())
            .filter(distinctByString);
          touchedKeys.push(...additionalKeys);
          collectedSTs = firstDiffIndex - 1;
          lastRuntimeResult = stateTransitions;
          continue;
        }
      }

      const latestST = stateTransitions.at(collectedSTs);

      if (
        latestST !== undefined &&
        !touchedKeys.includes(latestST.path.toString())
      ) {
        touchedKeys.push(latestST.path.toString());
      }

      collectedSTs += 1;

      lastRuntimeResult = stateTransitions;
    } while (collectedSTs < numberMethodSTs);

    return lastRuntimeResult;
  }
}