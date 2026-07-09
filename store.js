"use strict";

// Persistence backend selector. The rest of the server only ever requires "./store" and
// uses this interface; which implementation runs is decided here by the environment:
//
//   DATABASE_URL set  -> Postgres (store-postgres.js): survives restarts, for deployment.
//   DATABASE_URL unset -> JSON files (store-json.js): zero setup, for local/offline dev.
//
// Both expose the identical interface:
//   init(), getUserByName(name), getUserById(id), createUser({name,salt,hash}),
//   listCharacters(userId), saveCharacter(userId, slot, data), deleteCharacter(userId, slot)

module.exports = process.env.DATABASE_URL
  ? require("./store-postgres")
  : require("./store-json");
