require("dotenv").config();
const test_request = require("supertest");
const common_models = require("colte-common-models");

// The app will be instantiated after database prep.
let app = null;
let db_specific_knex = null;

const databaseName = `colte_transfer_test_for_worker_${process.env.JEST_WORKER_ID}`;

beforeAll(async () => {
  // Setup knex to run seeds and migrations.
  let config = common_models.knexFile[process.env.NODE_ENV];

  // Normalize directories to be arrays
  if (!Array.isArray(config.migrations.directory)) {
    config.migrations.directory = [config.migrations.directory];
  }
  if (!Array.isArray(config.seeds.directory)) {
    config.seeds.directory = [config.seeds.directory];
  }

  // Set the path for all entries
  config.migrations.directory = config.migrations.directory.map(
    (path_i) => "../colte-common-models/" + path_i
  );
  config.seeds.directory = config.seeds.directory.map(
    (path_i) => "../colte-common-models/" + path_i
  );

  const knex = common_models.getKnexInstance(config);

  await knex
    .raw(`DROP DATABASE IF EXISTS ${databaseName};`)
    .then(() => {
      return knex.raw(`CREATE DATABASE ${databaseName};`);
    })
    .then(() => {
      process.env.DB_NAME = databaseName;
      app = require("../app");
    })
    .then(() => {
      // Update the config to point to the newly created database
      config.connection.database = databaseName;
      db_specific_knex = require("colte-common-models").getKnexInstance(config);
      return db_specific_knex.migrate.latest().then(() => {
        return db_specific_knex.seed.run();
      });
    });
});

afterAll(async () => {
  await db_specific_knex.raw(`DROP DATABASE IF EXISTS ${databaseName}`);
});

describe("transfer API", function () {
  it("Get main page valid address", async () => {
    const res = await test_request(app).get("/transfer").set("X-Forwarded-For", "192.168.151.2");
    expect(res.statusCode).toEqual(200);
  });
  it("Get main page invalid address", async () => {
    const res = await test_request(app).get("/transfer").set("X-Forwarded-For", "255.255.255.255");
    expect(res.statusCode).toEqual(403);
  });
  it("Post main page (invalid verb)", async () => {
    const res = await test_request(app)
      .post("/transfer")
      .set("X-Forwarded-For", "192.168.151.2")
      .send("fish");
    expect(res.statusCode).toEqual(405);
  });
  it("Get transfer api (invalid verb)", async () => {
    const res = await test_request(app)
      .get("/transfer/transfer")
      .set("X-Forwarded-For", "192.168.151.2");
    expect(res.statusCode).toEqual(405);
  });
  it("Post transfer api, invalid source address", async () => {
    const res = await test_request(app)
      .post("/transfer/transfer")
      .send({
        msisdn: "3",
        amount: 10.0,
      })
      .set("X-Forwarded-For", "0.0.0.0");
    expect(res.statusCode).toEqual(403);
  });
  it("Post transfer api, invalid dest address", async () => {
    const res = await test_request(app)
      .post("/transfer/transfer")
      .send({
        msisdn: "1337",
        amount: 10.0,
      })
      .set("X-Forwarded-For", "192.168.151.2");
    expect(res.statusCode).toEqual(302);

    const status = await test_request(app).get("/transfer").set("X-Forwarded-For", "192.168.151.2");
    expect(status.text).toEqual(expect.stringContaining("Current Balance: $2500"));
  });
  it("Post transfer api, missing dest address", async () => {
    const res = await test_request(app)
      .post("/transfer/transfer")
      .send({amount: 10.0})
      .set("X-Forwarded-For", "192.168.151.2");
    expect(res.statusCode).toEqual(400);
  });
  it("Post transfer api, missing amount", async () => {
    const res = await test_request(app)
      .post("/transfer/transfer")
      .send({msisdn: "3"})
      .set("X-Forwarded-For", "192.168.151.2");
    expect(res.statusCode).toEqual(400);
  });
  it("Post transfer api, insufficient source funds", async () => {
    const res = await test_request(app)
      .post("/transfer/transfer")
      .send({
        msisdn: "3",
        amount: 10.0,
      })
      .set("X-Forwarded-For", "192.168.151.4");
    expect(res.statusCode).toEqual(302);

    const status = await test_request(app).get("/transfer").set("X-Forwarded-For", "192.168.151.4");
    expect(status.text).toEqual(expect.stringContaining("Current Balance: $0"));
  });
  it("Post transfer api, self-transfer", async () => {
    const res = await test_request(app)
      .post("/transfer/transfer")
      .send({
        msisdn: "2",
        amount: 10.0,
      })
      .set("X-Forwarded-For", "192.168.151.2");
    expect(res.statusCode).toEqual(302);

    const status = await test_request(app).get("/transfer").set("X-Forwarded-For", "192.168.151.2");
    expect(status.text).toEqual(expect.stringContaining("Current Balance: $2500"));
  });
  it("Post transfer api, valid transfer", async () => {
    const res = await test_request(app)
      .post("/transfer/transfer")
      .send({
        msisdn: "3",
        amount: 10.0,
      })
      .set("X-Forwarded-For", "192.168.151.2");
    expect(res.statusCode).toEqual(302);

    const status1 = await test_request(app)
      .get("/transfer")
      .set("X-Forwarded-For", "192.168.151.2");
    expect(status1.text).toEqual(expect.stringContaining("Current Balance: $2490"));

    const status2 = await test_request(app)
      .get("/transfer")
      .set("X-Forwarded-For", "192.168.151.3");
    expect(status2.text).toEqual(expect.stringContaining("Current Balance: $10"));
  });
  it("Post transfer api, one way transfer stress consistency test", async () => {
    // Generate many concurrent requests, and ensure the results match expected.
    let promises = [];
    for (i = 0; i < 100; ++i) {
      promises.push(
        test_request(app)
          .post("/transfer/transfer")
          .send({
            msisdn: "3",
            amount: 24.9,
          })
          .set("X-Forwarded-For", "192.168.151.2")
      );
    }
    results = await Promise.all(promises);

    // Validate request results
    for (i = 0; i < 100; ++i) {
      expect(results[i].statusCode).toEqual(302);
    }

    // Validate Balances
    const status1 = await test_request(app)
      .get("/transfer")
      .set("X-Forwarded-For", "192.168.151.2");
    expect(status1.text).toEqual(expect.stringContaining("Current Balance: $0"));

    const status2 = await test_request(app)
      .get("/transfer")
      .set("X-Forwarded-For", "192.168.151.3");
    expect(status2.text).toEqual(expect.stringContaining("Current Balance: $2500"));
  });
  it("Post transfer api, two way transfer stress consistency test", async () => {
    // Generate many concurrent requests, and ensure the results match expected.
    let promises = [];
    for (i = 0; i < 50; ++i) {
      promises.push(
        test_request(app)
          .post("/transfer/transfer")
          .send({
            msisdn: "3",
            amount: 24.9,
          })
          .set("X-Forwarded-For", "192.168.151.2")
      );
      promises.push(
        test_request(app)
          .post("/transfer/transfer")
          .send({
            msisdn: "2",
            amount: 10,
          })
          .set("X-Forwarded-For", "192.168.151.3")
      );
    }
    results = await Promise.all(promises);

    // Validate request results
    for (i = 0; i < 100; ++i) {
      expect(results[i].statusCode).toEqual(302);
    }

    // Validate Balances
    const status2 = await test_request(app)
      .get("/transfer")
      .set("X-Forwarded-For", "192.168.151.2");
    const user2_rexp_result = status2.text.match(
      /<p>Current Balance: \$(?<balance>[0-9,\.,\,]*)<\/p>/
    );
    const user2balance = Number(user2_rexp_result.groups.balance);

    const status3 = await test_request(app)
      .get("/transfer")
      .set("X-Forwarded-For", "192.168.151.3");

    const user3_rexp_result = status3.text.match(
      /<p>Current Balance: \$(?<balance>[0-9,\.,\,]*)<\/p>/
    );
    const user3balance = Number(user3_rexp_result.groups.balance);

    expect(user2balance + user3balance).toEqual(2500);
  });
});
