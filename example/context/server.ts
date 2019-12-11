import * as UUID from "uuid-js"
import {createRpcServer, LocalTopicImpl} from "../../src"
import {Services, Todo, TodoService} from "../basic/shared"
import {RpcConnectionContext} from "../../src/rpc"

interface ServiceContext extends RpcConnectionContext {
  sql(): Promise<any>
  userId: string
}

let storage: Todo[] = []

class TodoServiceImpl implements TodoService {
  async addTodo({text}, ctx: ServiceContext) {
    storage.push({
      id: "" + Math.random(),
      text,
      status: "open",
    })

    console.log("New todo item added")

    this.todos.trigger()
  }

  todos = new LocalTopicImpl(async (_, ctx: ServiceContext) => storage)
}

const services: Services = {
  todo: new TodoServiceImpl(),
}

function decodeToken(token) {
  return token
}

// TODO throw error if auth failed
function createContext(req): ServiceContext {
  let protocol: any = req.headers["sec-websocket-protocol"]
  if (protocol && Array.isArray(protocol)) protocol = protocol[0]

  return {
    remoteId: UUID.create().toString(),
    protocol,
    sql: null,
    userId: decodeToken(req.headers["Authentication"]),
  }
}

export async function startTransaction(ctx, next) {
  try {
    ctx.sql = async query => {
      console.log("Execeute query in DB", query)
    }

    await ctx.sql("begin")
    const r = await next()
    await ctx.sql("commit")
    return r
  } catch (e) {
    await ctx.sql("rollback")
    throw e
  }
}

createRpcServer(services, {wss: {port: 5555}, createContext, localMiddleware: startTransaction})

console.log("RPC Server started at ws://localhost:5555")
