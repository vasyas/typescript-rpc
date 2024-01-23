import {Services} from "./api.js"
import {consumeServices} from "../client/index.js"

const {remote} = await consumeServices<Services>("http://localhost:8080/rpc")

console.log("Client created")

await remote.todo.getTodos.subscribe((todos) => {
  console.log("Got todo items", todos)
}, null)

await remote.todo.addTodo({text: "Buy groceries"})
