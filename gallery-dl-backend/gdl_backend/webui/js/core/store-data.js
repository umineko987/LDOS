const IMMUTABLE_VALUES = new WeakSet();
const READONLY_MAPS = new WeakSet();
const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function cloneInput(value, seen = new WeakSet()) {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) {
    return value;
  }
  if (typeof value !== "object") throw new TypeError("状态 payload 只能包含可复制数据");
  if (seen.has(value)) throw new TypeError("状态 payload 不得包含循环引用");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => cloneInput(item, seen));
    if (value instanceof Map) {
      const result = new Map();
      for (const [key, item] of value) {
        result.set(cloneInput(key, seen), cloneInput(item, seen));
      }
      return result;
    }
    if (!isPlainObject(value)) throw new TypeError("状态 payload 包含不支持的对象类型");
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) {
        throw new TypeError("状态 payload 包含危险对象键");
      }
      result[key] = cloneInput(item, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function readonlyMutation() {
  throw new TypeError("中央状态只允许通过 action 修改");
}

function readonlyMap(source, seen) {
  const target = new Map();
  let proxy;
  proxy = new Proxy(target, {
    get(map, property) {
      if (property === "set" || property === "delete" || property === "clear") {
        return readonlyMutation;
      }
      if (property === "size") return map.size;
      if (property === "forEach") {
        return (callback, thisArg) => {
          map.forEach((value, key) => callback.call(thisArg, value, key, proxy));
        };
      }
      const value = Reflect.get(map, property, map);
      return typeof value === "function" ? value.bind(map) : value;
    },
  });
  seen.set(source, proxy);
  for (const [key, value] of source) {
    target.set(makeImmutable(key, seen), makeImmutable(value, seen));
  }
  Object.freeze(target);
  READONLY_MAPS.add(proxy);
  IMMUTABLE_VALUES.add(proxy);
  return proxy;
}

export function makeImmutable(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (IMMUTABLE_VALUES.has(value) || READONLY_MAPS.has(value)) return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Map) return readonlyMap(value, seen);

  const target = Array.isArray(value) ? [] : {};
  seen.set(value, target);
  if (Array.isArray(value)) {
    for (const item of value) target.push(makeImmutable(item, seen));
  } else {
    if (!isPlainObject(value)) throw new TypeError("中央状态包含不支持的对象类型");
    for (const [key, item] of Object.entries(value)) {
      target[key] = makeImmutable(item, seen);
    }
  }
  Object.freeze(target);
  IMMUTABLE_VALUES.add(target);
  return target;
}
