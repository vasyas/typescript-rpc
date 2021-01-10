import {
  DataConsumer,
  DataSupplier,
  ITEM_NAME_SEPARATOR,
  Method,
  ServiceItem,
  Topic,
  Transport,
} from "./core"

export async function createRpcServer(services: any, transport: Transport) {
  prepareLocal(services, transport)

  transport.listenCalls(async (itemName, body, respond) => {
    const item = getServiceItem(services, itemName)

    if (!item) return
    // warn about unhandled item

    if ("method" in item) {
      // local method request
      invokeMethod(item, body, respond)
    } else {
      // get data from topic
      getTopicData(item as any, body, respond)
    }
  })
}

async function invokeMethod(item: {method: Method; object: any}, req: any, respond) {
  const ctx = null
  const response = await item.method.call(item.object, req, ctx)
  respond(response)
}

async function getTopicData(
  item: {topic: LocalTopicImpl<never, any>; object: any},
  filter: any,
  respond
) {
  // TODO should have access to LocalTopic supplier

  const ctx = null
  const response = await item.topic.supplier(filter, ctx)
  respond(response)
}

function getServiceItem(services: any, name: string): ServiceItem {
  if (!name) {
    return null
  }

  const names = name.split(ITEM_NAME_SEPARATOR)

  const item = services[names[0]]

  if (typeof item == "object") {
    if ("getTopicName" in item) return {topic: item as any, object: services}

    if (!item) {
      return null
    }

    return getServiceItem(item as any, names.slice(1).join(ITEM_NAME_SEPARATOR))
  }

  return {method: item, object: services}
}

function prepareLocal(services: any, transport: Transport, prefix: string = "") {
  const keys = getObjectProps(services)

  keys.forEach(key => {
    const item = services[key]

    if (typeof item == "object") {
      const name = prefix + key

      if ("setTransport" in item) {
        item.setTransport(transport)
      }

      if ("setTopicName" in item) {
        item.setTopicName(name)
        return
      }

      return prepareLocal(item, transport, name + ITEM_NAME_SEPARATOR)
    }
  })
}

function getObjectProps(obj) {
  let props = []

  while (!!obj && obj != Object.prototype) {
    props = props.concat(Object.getOwnPropertyNames(obj))
    obj = Object.getPrototypeOf(obj)
  }

  return Array.from(new Set(props)).filter(p => p != "constructor")
}

export class LocalTopicImpl<D, F, TD = D> implements Topic<D, F, TD> {
  constructor(readonly supplier: DataSupplier<D, F>) {}

  private name: string
  private transport: Transport

  getTopicName(): string {
    return this.name
  }

  setTopicName(s: string) {
    this.name = s
  }

  setTransport(transport: Transport) {
    this.transport = transport
  }

  /**
   * Send data
   */
  trigger(p: Partial<F> = {}, data?: TD): void {
    if (!this.transport)
      throw new Error(`Topic ${this.name} transport is not set, server probably not started`)
    ;(async () => {
      if (data === undefined) {
        data = (await this.supplier(p as any, null)) as any
      }

      this.transport.publish(this.getTopicName(), p, data)
    })()
  }

  // only required fort ServiceImpl to implement Service interfaces
  async get(params?: F): Promise<D> {
    return undefined
  }

  async subscribe(consumer: DataConsumer<D>, params?: F, subscriptionKey?: any): Promise<any> {}

  unsubscribe(params?: F, subscriptionKey?: any) {}
}
