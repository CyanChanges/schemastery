type Dict<T = any, K extends string = string> = { [key in K]?: T }
type Intersect<U> = (U extends any ? (arg: U) => void : never) extends ((arg: infer I) => void) ? I : never

function isNullable(value: any) {
  return value === null || value === undefined
}

function isObject(data: any) {
  return data && typeof data === 'object' && !Array.isArray(data)
}

export class SchemaError extends TypeError {
  readonly name = 'SchemaError'

  static current: Schema = null

  constructor(message: string, error?: SchemaError) {
    super(message)
    this.init(error)
  }

  private init(error?: SchemaError) {
    if (!SchemaError.current) return
    let cap: RegExpExecArray
    const lines = this.stack.split('\n')
    if (cap = /^ {4}at .+ (\(.+\))$/.exec(lines[1])) {
      lines[1] = `    at Schema<${SchemaError.current}> ${cap[1]}`
    } else {
      lines[1] = `    at Schema<${SchemaError.current}> (${lines[1].slice(7)})`
    }
    this.stack = lines.join('\n')
  }
}

export interface Schema<S = any, T = S> extends Schema.Base<T> {
  (data: S): T
  (data?: null): T
  new (data: S): T
  new (data?: null): T
  [kSchema]: true
  toJSON(): Schema.Base<T>
  required(): Schema<S, T>
  hidden(): Schema<S, T>
  adaptive(): Schema<S, T>
  default(value: T): Schema<S, T>
  comment(text: string): Schema<S, T>
  description(text: string): Schema<S, T>
}

export namespace Schema {
  export type From<T> =
    | T extends string | number | boolean ? Schema<T>
    : T extends Schema ? T
    : T extends typeof String ? Schema<string>
    : T extends typeof Number ? Schema<number>
    : T extends typeof Boolean ? Schema<boolean>
    : T extends Constructor<infer S> ? Schema<S>
    : never

  type _TypeS<X> = X extends Schema<infer S, unknown> ? S : never
  type _TypeT<X> = ReturnType<Extract<X, Schema>>

  export type TypeS<X> = _TypeS<From<X>>
  export type TypeT<X> = _TypeT<From<X>>
  export type Resolve = (data: any, schema?: Schema, strict?: boolean) => [any, any?]

  export interface Base<T = any> {
    type: string
    sKey?: Schema
    inner?: Schema
    list?: Schema[]
    dict?: Dict<Schema>
    callback?: Function
    value?: T
    meta?: Meta<T>
    toString(inline?: boolean): string
  }

  export interface Meta<T = any> {
    default?: T extends {} ? Partial<T> : T
    required?: boolean
    hidden?: boolean
    adaptive?: boolean
    description?: string
    comment?: string
  }

  type TupleS<X extends readonly any[]> = X extends readonly [infer L, ...infer R] ? [TypeS<L>?, ...TupleS<R>] : any[]
  type TupleT<X extends readonly any[]> = X extends readonly [infer L, ...infer R] ? [TypeT<L>?, ...TupleT<R>] : any[]
  type ObjectS<X extends Dict> = { [K in keyof X]?: TypeS<X[K]> } & Dict
  type ObjectT<X extends Dict> = { [K in keyof X]?: TypeT<X[K]> } & Dict
  type Constructor<T = any> = new (...args: any[]) => T

  export interface Static {
    <T = any>(options: Base<T>): Schema<T>
    new <T = any>(options: Base<T>): Schema<T>
    prototype: Schema
    resolve: Resolve
    from<T>(source: T): Schema<From<T>>
    extend(type: string, resolve: Resolve): void
    any(): Schema<any>
    never(): Schema<never>
    const<T>(value: T): Schema<T>
    string(): Schema<string>
    number(): Schema<number>
    boolean(): Schema<boolean>
    is<T>(constructor: Constructor<T>): Schema<T>
    array<X>(inner: X): Schema<TypeS<X>[], TypeT<X>[]>
    dict<X, Y extends string | Schema<any, string>>(inner: X, sKey?: Y): Schema<Dict<TypeS<X>, TypeS<Y>>, Dict<TypeT<X>, TypeT<Y>>>
    tuple<X extends readonly any[]>(list: X): Schema<TupleS<X>, TupleT<X>>
    object<X extends Dict>(dict: X): Schema<ObjectS<X>, ObjectT<X>>
    union<X>(list: readonly X[]): Schema<TypeS<X>, TypeT<X>>
    intersect<X>(list: readonly X[]): Schema<Intersect<TypeS<X>>, Intersect<TypeT<X>>>
    transform<X, T>(inner: X, callback: (value: TypeS<X>) => T): Schema<TypeS<X>, T>
  }
}

const kSchema = Symbol('schemastery')

export const Schema = function (options: Schema.Base) {
  const schema = function (data: any) {
    return Schema.resolve(data, schema)[0]
  } as Schema
  Object.setPrototypeOf(schema, Schema.prototype)
  Object.assign(schema, options)
  schema.meta ||= {}
  return schema
} as Schema.Static

Schema.prototype = Object.create(Function.prototype)

Schema.prototype[kSchema] = true

Schema.prototype.toJSON = function toJSON() {
  return { ...this }
}

for (const key of ['required', 'hidden', 'adaptive']) {
  Object.assign(Schema.prototype, {
    [key]() {
      this.meta[key] = true
      return this
    },
  })
}

for (const key of ['default', 'comment', 'description']) {
  Object.assign(Schema.prototype, {
    [key](value: any) {
      this.meta[key] = value
      return this
    },
  })
}

const resolvers: Dict<Schema.Resolve> = {}

Schema.extend = function extend(type: string, resolve) {
  resolvers[type] = resolve
}

Schema.resolve = function resolve(data, schema, hint) {
  if (!schema) return [data]
  const previous = SchemaError.current

  try {
    SchemaError.current = schema

    if (isNullable(data)) {
      if (schema.meta.required) throw new SchemaError(`missing required value`)
      const fallback = schema.meta.default
      if (isNullable(fallback)) return [data] as [any]
      data = fallback
    }
  
    const callback = resolvers[schema.type]
    if (!callback) throw new SchemaError(`unsupported type "${schema.type}"`)

    return callback(data, schema, hint)
  } catch (error) {
    if (error instanceof SchemaError) {
      error = new SchemaError(error.message, error)
    }
    throw error
  } finally {
    SchemaError.current = previous
  }
}

Schema.from = function from(source: any) {
  if (isNullable(source)) {
    return Schema.any()
  } else if (['string', 'number', 'boolean'].includes(typeof source)) {
    return Schema.const(source).required()
  } else if (source[kSchema]) {
    return source
  } else if (typeof source === 'function') {
    switch (source) {
      case String: return Schema.string()
      case Number: return Schema.number()
      case Boolean: return Schema.boolean()
      default: return Schema.is(source)
    }
  } else {
    throw new SchemaError(`cannot infer schema from ${source}`)
  }
}

Schema.extend('any', (data) => {
  return [data]
})

Schema.extend('never', (data) => {
  throw new SchemaError(`expected nullable but got ${JSON.stringify(data)}`)
})

Schema.extend('const', (data, { value }) => {
  if (data === value) return [value]
  throw new SchemaError(`expected ${value} but got ${JSON.stringify(data)}`)
})

Schema.extend('string', (data) => {
  if (typeof data === 'string') return [data]
  throw new SchemaError(`expected string but got ${JSON.stringify(data)}`)
})

Schema.extend('number', (data) => {
  if (typeof data === 'number') return [data]
  throw new SchemaError(`expected number but got ${JSON.stringify(data)}`)
})

Schema.extend('boolean', (data) => {
  if (typeof data === 'boolean') return [data]
  throw new SchemaError(`expected boolean but got ${JSON.stringify(data)}`)
})

Schema.extend('is', (data, { callback }) => {
  if (data instanceof callback) return [data]
  throw new SchemaError(`expected ${callback.name} but got ${data}`)
})

function property(data: any, key: keyof any, schema?: Schema) {
  const [value, adapted] = Schema.resolve(data[key], schema)
  if (!isNullable(adapted)) data[key] = adapted
  return value
}

Schema.extend('array', (data, { inner }) => {
  if (!Array.isArray(data)) throw new SchemaError(`expected array but got ${JSON.stringify(data)}`)
  return [data.map((_, index) => property(data, index, inner))]
})

Schema.extend('dict', (data, { inner, sKey }, strict) => {
  if (!isObject(data)) throw new SchemaError(`expected object but got ${JSON.stringify(data)}`)
  const result = {}
  for (const key in data) {
    let rKey: string
    try {
      rKey = Schema.resolve(key, sKey)[0]
    } catch (error) {
      if (strict) continue
      throw error
    }
    result[rKey] = property(data, key, inner)
    data[rKey] = data[key]
    delete data[key]
  }
  return [result]
})

Schema.extend('tuple', (data, { list }, strict) => {
  if (!Array.isArray(data)) throw new SchemaError(`expected array but got ${JSON.stringify(data)}`)
  const result = list.map((inner, index) => property(data, index, inner))
  if (strict) return [result]
  result.push(...data.slice(list.length))
  return [result]
})

function merge(result: any, data: any) {
  for (const key in data) {
    if (key in result) continue
    result[key] = data[key]
  }
}

Schema.extend('object', (data, { dict }, strict) => {
  if (!isObject(data)) throw new SchemaError(`expected object but got ${JSON.stringify(data)}`)
  const result = {}
  for (const key in dict) {
    const value = property(data, key, dict[key])
    if (!isNullable(value) || key in data) {
      result[key] = value
    }
  }
  if (!strict) merge(result, data)
  return [result]
})

Schema.extend('union', (data, { list }) => {
  const messages: string[] = []
  for (const inner of list) {
    try {
      return Schema.resolve(data, inner)
    } catch (error) {
      messages.push(error.message)
    }
  }
  const error = new SchemaError(`expected union but got ${JSON.stringify(data)}`)
  throw error
})

Schema.extend('intersect', (data, { list }) => {
  const result = {}
  for (const inner of list) {
    const value = Schema.resolve(data, inner, true)[0]
    Object.assign(result, value)
  }
  if (isObject(data)) merge(result, data)
  return [result]
})

Schema.extend('transform', (data, { inner, callback }) => {
  const [result, adapted = data] = Schema.resolve(data, inner, true)
  if (isObject(data)) {
    const temp = {}
    for (const key in result) {
      if (!(key in data)) continue
      temp[key] = data[key]
      delete data[key]
    }
    Object.assign(data, callback(temp))
    return [callback(result)]
  } else {
    return [callback(result), callback(adapted)]
  }
})

type Formatter = (schema: Schema, inline?: boolean) => string

function defineMethod(name: string, keys: (keyof Schema.Base)[], format: Formatter) {
  Object.assign(Schema, {
    [name](...args: any[]) {
      const schema = new Schema({ type: name })
      schema.toString = format.bind(null, schema)
      keys.forEach((key, index) => {
        switch (key) {
          case 'sKey': schema.sKey = Schema.from(args[index]); break
          case 'inner': schema.inner = Schema.from(args[index]); break
          case 'list': schema.list = args[index].map(Schema.from); break
          case 'dict': schema.dict = Object.fromEntries(Object.entries(args[index]).map(([key, value]) => [key, Schema.from(value)])); break
          default: schema[key] = args[index]
        }
      })
      return schema
    },
  })
}

defineMethod('is', ['callback'], ({ callback }) => callback.name)
defineMethod('any', [], () => 'any')
defineMethod('never', [], () => 'never')
defineMethod('const', ['value'], ({ value }) => typeof value === 'string' ? JSON.stringify(value) : value)
defineMethod('string', [], () => 'string')
defineMethod('number', [], () => 'number')
defineMethod('boolean', [], () => 'boolean')
defineMethod('array', ['inner'], ({ inner }) => `${inner.toString(true)}[]`)
defineMethod('dict', ['inner', 'sKey'], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`)
defineMethod('tuple', ['list'], ({ list }) => `[${list.map((inner) => inner.toString()).join(', ')}]`)

defineMethod('object', ['dict'], ({ dict }) => {
  if (Object.keys(dict).length === 0) return '{}'
  return `{ ${Object.entries(dict).map(([key, inner]) => {
    return `${key}${inner.meta.required ? '' : '?'}: ${inner.toString()}`
  }).join(', ')} }`
})

defineMethod('union', ['list'], ({ list }, inline) => {
  const result = list.map(({ toString: format }) => format()).join(' | ')
  return inline ? `(${result})` : result
})

defineMethod('intersect', ['list'], ({ list }) => {
  return `${list.map((inner) => inner.toString(true)).join(' & ')}`
})

defineMethod('transform', ['inner', 'callback'], ({ inner }, isInner) => inner.toString(isInner))

export default Schema
