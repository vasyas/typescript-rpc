import {ExtractPromiseResult} from "./utils/types.js"

export type RemoteFunction = (...args: any[]) => Promise<any>
export type Services = {
  [key: string]: Services | RemoteFunction
}

export type Consumer<T extends RemoteFunction> = (data: ExtractPromiseResult<ReturnType<T>>) => void

export class RpcError extends Error {
  constructor(
    public readonly code: number,
    message?: string
  ) {
    super(message)
  }
}

export enum RpcErrors {
  NotFound = 404,
  Timeout = 504,
}

export type CallOptions = {
  timeout: number
}

export const CLIENT_ID_HEADER = "x-rpc-client-id"
