import {InvocationType, RpcContext, Services} from "../rpc.js"
import {HttpClient} from "./HttpClient.js"
import {RemoteSubscriptions} from "./RemoteSubscriptions.js"
import {WebSocketConnection} from "./WebSocketConnection.js"
import {nanoid} from "nanoid"
import {createRemote, ServicesWithSubscriptions} from "./remote.js"
import {ConsumeServicesOptions, RpcClient} from "./index.js"
import {withMiddlewares} from "../utils/middleware.js"

export class RpcClientImpl<S extends Services> implements RpcClient {
  constructor(
    url: string,
    private readonly options: ConsumeServicesOptions
  ) {
    this.httpClient = new HttpClient(url, this.clientId, {callTimeout: options.callTimeout})
    this.remoteSubscriptions = new RemoteSubscriptions()

    this.connection = new WebSocketConnection(
      url,
      this.clientId,
      {
        errorDelayMaxDuration: options.errorDelayMaxDuration,
        reconnectDelay: options.reconnectDelay,
        pingInterval: options.pingInterval,
      },
      (itemName, parameters, data) => {
        this.remoteSubscriptions.consume(itemName, parameters, data)
      },
      this.resubscribe
    )
  }

  private readonly clientId = nanoid()
  private readonly httpClient: HttpClient
  private readonly remoteSubscriptions: RemoteSubscriptions
  private readonly connection: WebSocketConnection

  isConnected() {
    return this.connection.isConnected()
  }

  close() {
    return this.connection.close()
  }

  _allSubscriptions() {
    const result: Array<
      [itemName: string, parameters: unknown[], consumers: (d: unknown) => void]
    > = []

    for (const [
      itemName,
      parameters,
      consumers,
    ] of this.remoteSubscriptions.getAllSubscriptions()) {
      for (const consumer of consumers) {
        result.push([itemName, parameters, consumer])
      }
    }
    return result
  }

  _webSocket() {
    return this.connection._webSocket()
  }

  createRemote(): ServicesWithSubscriptions<S> {
    return createRemote<S>({
      call: this.call,
      subscribe: this.subscribe,
      unsubscribe: this.unsubscribe,
    })
  }

  private invoke(
    remoteFunctionName: string,
    invocationType: InvocationType,
    next: (...params: unknown[]) => Promise<unknown>,
    parameters: unknown[]
  ) {
    const ctx: RpcContext = {
      clientId: this.clientId,
      remoteFunctionName: remoteFunctionName,
      invocationType: invocationType,
    }

    return withMiddlewares(ctx, this.options.middleware, next, ...parameters)
  }

  private call = (itemName: string, parameters: unknown[]): Promise<unknown> => {
    // TODO per-call callTimeout

    return this.invoke(
      itemName,
      InvocationType.Call,
      (...parameters) => this.httpClient.call(itemName, parameters),
      parameters
    )
  }

  private subscribe = async (
    itemName: string,
    parameters: unknown[],
    consumer: (d: unknown) => void
  ): Promise<void> => {
    const cached = this.remoteSubscriptions.getCached(itemName, parameters)

    if (cached !== undefined) {
      consumer(cached)
    }

    if (this.options.subscribe) {
      this.connection.connect().catch((e) => {
        // ignored
      })
    }

    const data = await this.httpClient.subscribe(itemName, parameters) // TODO callTimeout
    this.remoteSubscriptions.subscribe(data, itemName, parameters, consumer)
  }

  private unsubscribe = async (
    itemName: string,
    parameters: unknown[],
    consumer: (d: unknown) => void
  ) => {
    const noSubscriptionsLeft = this.remoteSubscriptions.unsubscribe(itemName, parameters, consumer)

    if (noSubscriptionsLeft) {
      await this.httpClient.unsubscribe(itemName, parameters)
    }
  }

  private resubscribe = () => {
    for (const [itemName, params, consumers] of this.remoteSubscriptions.getAllSubscriptions()) {
      this.httpClient
        .subscribe(itemName, params)
        .then((data) => {
          this.remoteSubscriptions.consume(itemName, params, data)
        })
        .catch((e) => {
          for (const consumer of consumers) {
            this.remoteSubscriptions.unsubscribe(itemName, params, consumer)
          }
        })
    }
  }
}
