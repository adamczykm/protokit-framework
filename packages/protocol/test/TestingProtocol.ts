import { WithZkProgrammable, ZkProgrammable } from "@proto-kit/common";
import { RuntimeZkProgrammable } from "@proto-kit/module";
import { container } from "tsyringe";
import {
  AccountStateHook,
  BlockHeightHook,
  BlockProver,
  LastStateRootBlockHook,
  MethodPublicOutput,
  NoOpStateTransitionWitnessProvider,
  Protocol,
  StateTransitionProver
} from "../src";

class RuntimeMock implements WithZkProgrammable<undefined, MethodPublicOutput> {
  zkProgrammable: ZkProgrammable<undefined, MethodPublicOutput> =
    undefined as unknown as ZkProgrammable<undefined, MethodPublicOutput>;
}

export function createAndInitTestingProtocol() {
  const ProtocolClass = Protocol.from({
    modules: {
      StateTransitionProver: StateTransitionProver,
      BlockProver: BlockProver,
      AccountState: AccountStateHook,
      BlockHeight: BlockHeightHook,
      LastStateRoot: LastStateRootBlockHook,
    },
  });
  const protocol = new ProtocolClass();

  protocol.configure({
    BlockProver: {},
    AccountState: {},
    BlockHeight: {},
    StateTransitionProver: {},
    LastStateRoot: {},
  });
  protocol.create(() => container.createChildContainer());

  protocol.registerValue({
    StateTransitionWitnessProvider: new NoOpStateTransitionWitnessProvider(),
    Runtime: new RuntimeMock(),
  });

  return protocol;
}
