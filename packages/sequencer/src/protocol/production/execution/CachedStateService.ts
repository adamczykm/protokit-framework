import { InMemoryStateService } from "@yab/module";
import { Field } from "snarkyjs";

import { AsyncStateService } from "../state/AsyncStateService";

const errors = {
  parentIsUndefined: () => new Error("Parent StateService is undefined"),
};

export class CachedStateService
  extends InMemoryStateService
  implements AsyncStateService
{
  public constructor(private readonly parent: AsyncStateService | undefined) {
    super();
  }

  public get(key: Field): Field[] | undefined {
    return super.get(key);
  }

  private assertParentNotNull(
    parent: AsyncStateService | undefined
  ): asserts parent is AsyncStateService {
    if (parent === undefined) {
      throw errors.parentIsUndefined();
    }
  }

  public async preloadKey(key: Field) {
    // Only preload it if it hasn't been preloaded previously
    if (this.parent !== undefined && this.get(key) === undefined) {
      const value = await this.parent.getAsync(key);
      console.log(
        `Preloading ${key.toString()}: ${
          value?.map((i) => i.toString()) ?? []
        }`
      );
      this.set(key, value);
    }
  }

  public async preloadKeys(keys: Field[]): Promise<void> {
    await Promise.all(
      keys.map(async (key) => {
        await this.preloadKey(key);
      })
    );
  }

  public async getAsync(key: Field): Promise<Field[] | undefined> {
    return this.get(key);
  }

  public async setAsync(key: Field, value: Field[] | undefined): Promise<void> {
    this.set(key, value);
  }

  /**
   * Merges all caches set() operation into the parent and
   * resets this instance to the parent's state (by clearing the cache and
   * defaulting to the parent)
   */
  public async mergeIntoParent() {
    const { parent, values } = this;
    this.assertParentNotNull(parent);

    // Set all cached values on parent
    const promises = Object.entries(values).map(async (value) => {
      console.log(`Merging into parent ${value[0]}: ${value[1]}`);
      await parent.setAsync(Field(value[0]), value[1]);
    });
    await Promise.all(promises);
    // Clear cache
    this.values = {};
  }
}
