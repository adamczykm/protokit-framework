/* eslint-disable guard-for-in */
import {
  ModuleContainer,
  ModulesRecord,
  TypedClass,
  ModuleContainerDefinition,
  log,
} from "@yab/common";
import { Runtime, RuntimeModulesRecord } from "@yab/module";
import {
  Protocol,
  ProtocolModulesRecord,
} from "@yab/protocol/src/protocol/Protocol";
import {
  StateTransitionWitnessProvider,
  StateTransitionWitnessProviderReference,
} from "@yab/protocol";
import { DependencyContainer, injectable } from "tsyringe";

import { SequencerModule } from "../builder/SequencerModule";

import { Sequenceable } from "./Sequenceable";
import { StorageDependencyFactory } from "../../storage/StorageDependencyFactory";
import { DependencyFactory } from "../builder/DependencyFactory";
import { MockStorageDependencyFactory } from "../../storage/MockStorageDependencyFactory";

export type SequencerModulesRecord = ModulesRecord<
  TypedClass<SequencerModule<unknown>>
>;

@injectable()
export class Sequencer<Modules extends SequencerModulesRecord>
  extends ModuleContainer<Modules>
  implements Sequenceable
{
  /**
   * Alternative constructor for Sequencer
   * @param definition
   * @returns Sequencer
   */
  public static from<Modules extends SequencerModulesRecord>(
    definition: ModuleContainerDefinition<Modules>
  ) {
    return new Sequencer(definition);
  }

  public get runtime(): Runtime<RuntimeModulesRecord> {
    return this.container.resolve<Runtime<RuntimeModulesRecord>>("Runtime");
  }

  public get protocol(): Protocol<ProtocolModulesRecord> {
    return this.container.resolve<Protocol<ProtocolModulesRecord>>("Protocol");
  }

  public get dependencyContainer(): DependencyContainer {
    return this.container;
  }

  private initSequencer() {

  }

  /**
   * Starts the sequencer by iterating over all provided
   * modules to start each
   */
  public async start() {
    // Define DependencyFactories and initialize them
    const factories: TypedClass<DependencyFactory>[] = [
      MockStorageDependencyFactory,
    ];
    factories.forEach((factory) => {
      this.dependencyContainer
        .resolve(factory)
        .initDependencies(this.dependencyContainer);
    });

    // Set default STWitnessProvider inside protocol
    // TODO But what is the default? How do we deal with stages states (i.e. simulated state) in the DI container?
    const witnessProviderReference = this.protocol.dependencyContainer.resolve(
      StateTransitionWitnessProviderReference
    );
    // const witnessProvider =
    //   this.container.resolve<StateTransitionWitnessProvider>(
    //     "StateTransitionWitnessProvider"
    //   );
    // witnessProviderReference.setWitnessProvider(witnessProvider);

    // Log startup info
    const moduleClassNames = Object.values(this.definition.modules).map(
      (clazz) => clazz.name
    );
    log.info("Starting sequencer...");
    log.info("Modules:", moduleClassNames);
    log.info(
      "Factories:",
      factories.map((clazz) => clazz.name)
    );

    for (const moduleName in this.definition.modules) {
      const sequencerModule = this.resolve(moduleName);

      log.info(
        `Starting sequencer module ${moduleName} (${sequencerModule.constructor.name})`
      );
      // eslint-disable-next-line no-await-in-loop
      await sequencerModule.start();
    }
  }
}
