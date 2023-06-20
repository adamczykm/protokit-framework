// allows to reference interfaces as 'classes' rather than instances
export type TypedClassConstructor<Class> = new (...args: any[]) => Class;

/**
 * Using simple `keyof Target` would result into the key
 * being `string | number | symbol`, but we want just a `string`
 */
export type KeyOf<Target extends object> = Extract<keyof Target, string>;
// export type KeyOf<Target extends object> = keyof Target
