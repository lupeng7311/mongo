// Basic $changeNotification tests.
(function() {
    "use strict";

    const oplogProjection = {$project: {"_id.ts": 0}};

    /**
     * Tests the output of a $changeNotification stage, asserting only that the result at the end of
     * the change stream on the collection 'collection' (the newest matching entry in the oplog) is
     * equal to 'expectedResult'.
     *
     * Note this change assumes that the set of changes will fit within one batch.
     */
    function checkLatestChange(expectedResult, collection) {
        const cmdResponse = assert.commandWorked(db.runCommand({
            aggregate: collection.getName(),
            pipeline: [
                {$changeNotification: {}},
                // Strip the oplog fields we aren't testing.
                {$project: {"_id.ts": 0}}
            ],
            cursor: {}
        }));
        const firstBatch = cmdResponse.cursor.firstBatch;
        assert.neq(firstBatch.length, 0);
        assert.docEq(firstBatch[firstBatch.length - 1], expectedResult);
    }

    /**
     * Tests that there are no changes in the 'collection'.
     */
    function assertNoLatestChange(collection) {
        const cmdResponse = assert.commandWorked(db.runCommand({
            aggregate: collection.getName(),
            pipeline: [
                {$changeNotification: {}},
            ],
            cursor: {}
        }));
        assert.eq(cmdResponse.cursor.firstBatch.length, 0);
    }

    let replTest = new ReplSetTest({name: 'changeNotificationTest', nodes: 1});
    let nodes = replTest.startSet();
    replTest.initiate();
    replTest.awaitReplication();

    db = replTest.getPrimary().getDB('test');
    db.getMongo().forceReadMode('commands');

    jsTestLog("Testing single insert");
    assert.writeOK(db.t1.insert({_id: 0, a: 1}));
    let expected = {
        _id: {
            _id: 0,
            ns: "test.t1",
        },
        documentKey: {_id: 0},
        fullDocument: {_id: 0, a: 1},
        ns: {coll: "t1", db: "test"},
        operationType: "insert",
    };
    checkLatestChange(expected, db.t1);

    jsTestLog("Testing second insert");
    assert.writeOK(db.t1.insert({_id: 1, a: 2}));
    expected = {
        _id: {
            _id: 1,
            ns: "test.t1",
        },
        documentKey: {_id: 1},
        fullDocument: {_id: 1, a: 2},
        ns: {coll: "t1", db: "test"},
        operationType: "insert",
    };
    checkLatestChange(expected, db.t1);

    jsTestLog("Testing update");
    assert.writeOK(db.t1.update({_id: 0}, {a: 3}));
    expected = {
        _id: {_id: 0, ns: "test.t1"},
        documentKey: {_id: 0},
        fullDocument: {_id: 0, a: 3},
        ns: {coll: "t1", db: "test"},
        operationType: "replace",
    };
    checkLatestChange(expected, db.t1);

    jsTestLog("Testing update of another field");
    assert.writeOK(db.t1.update({_id: 0}, {b: 3}));
    expected = {
        _id: {_id: 0, ns: "test.t1"},
        documentKey: {_id: 0},
        fullDocument: {_id: 0, b: 3},
        ns: {coll: "t1", db: "test"},
        operationType: "replace",
    };
    checkLatestChange(expected, db.t1);

    jsTestLog("Testing upsert");
    assert.writeOK(db.t1.update({_id: 2}, {a: 4}, {upsert: true}));
    expected = {
        _id: {
            _id: 2,
            ns: "test.t1",
        },
        documentKey: {_id: 2},
        fullDocument: {_id: 2, a: 4},
        ns: {coll: "t1", db: "test"},
        operationType: "insert",
    };
    checkLatestChange(expected, db.t1);

    jsTestLog("Testing partial update with $inc");
    assert.writeOK(db.t1.insert({_id: 3, a: 5, b: 1}));
    assert.writeOK(db.t1.update({_id: 3}, {$inc: {b: 2}}));
    expected = {
        _id: {_id: 3, ns: "test.t1"},
        documentKey: {_id: 3},
        fullDocument: null,
        ns: {coll: "t1", db: "test"},
        operationType: "update",
        updateDescription: {removedFields: [], updatedFields: {b: 3}},
    };
    checkLatestChange(expected, db.t1);

    jsTestLog("Testing delete");
    assert.writeOK(db.t1.remove({_id: 1}));
    expected = {
        _id: {_id: 1, ns: "test.t1"},
        documentKey: {_id: 1},
        fullDocument: null,
        ns: {coll: "t1", db: "test"},
        operationType: "delete",
    };
    checkLatestChange(expected, db.t1);

    jsTestLog("Testing intervening write on another collection");
    assert.writeOK(db.t2.insert({_id: 100, c: 1}));
    checkLatestChange(expected, db.t1);
    expected = {
        _id: {
            _id: 100,
            ns: "test.t2",
        },
        documentKey: {_id: 100},
        fullDocument: {_id: 100, c: 1},
        ns: {coll: "t2", db: "test"},
        operationType: "insert",
    };
    checkLatestChange(expected, db.t2);

    jsTestLog("Testing rename");
    assert.writeOK(db.t2.renameCollection("t3"));
    expected = {_id: {ns: "test.$cmd"}, operationType: "invalidate", fullDocument: null};
    checkLatestChange(expected, db.t2);

    jsTestLog("Testing insert that looks like rename");
    assert.writeOK(db.t3.insert({_id: 101, renameCollection: "test.dne1", to: "test.dne2"}));
    assertNoLatestChange(db.dne1);
    assertNoLatestChange(db.dne2);

    // Now make sure the cursor behaves like a tailable awaitData cursor.
    jsTestLog("Testing tailability");
    let tailableCursor = db.tailable1.aggregate([{$changeNotification: {}}, oplogProjection]);
    assert(!tailableCursor.hasNext());
    assert.writeOK(db.tailable1.insert({_id: 101, a: 1}));
    assert(tailableCursor.hasNext());
    assert.docEq(tailableCursor.next(), {
        _id: {
            _id: 101,
            ns: "test.tailable1",
        },
        documentKey: {_id: 101},
        fullDocument: {_id: 101, a: 1},
        ns: {coll: "tailable1", db: "test"},
        operationType: "insert",
    });

    jsTestLog("Testing awaitdata");
    let res = assert.commandWorked(db.runCommand({
        aggregate: "tailable2",
        pipeline: [{$changeNotification: {}}, oplogProjection],
        cursor: {}
    }));
    let aggcursor = res.cursor;

    // We should get a valid cursor.
    assert.neq(aggcursor.id, 0);

    // Initial batch size should be zero as there should be no data.
    assert.eq(aggcursor.firstBatch.length, 0);

    // No data, so should return no results, but cursor should remain valid.
    res = assert.commandWorked(
        db.runCommand({getMore: aggcursor.id, collection: "tailable2", maxTimeMS: 50}));
    aggcursor = res.cursor;
    assert.neq(aggcursor.id, 0);
    assert.eq(aggcursor.nextBatch.length, 0);

    // Now insert something in parallel while waiting for it.
    let insertshell = startParallelShell(function() {
        // Wait for the getMore to appear in currentop.
        assert.soon(function() {
            return db.currentOp({op: "getmore", "command.collection": "tailable2"}).inprog.length ==
                1;
        });
        assert.writeOK(db.tailable2.insert({_id: 102, a: 2}));
    });
    res = assert.commandWorked(
        db.runCommand({getMore: aggcursor.id, collection: "tailable2", maxTimeMS: 5 * 60 * 1000}));
    aggcursor = res.cursor;
    assert.eq(aggcursor.nextBatch.length, 1);
    assert.docEq(aggcursor.nextBatch[0], {
        _id: {
            _id: 102,
            ns: "test.tailable2",
        },
        documentKey: {_id: 102},
        fullDocument: {_id: 102, a: 2},
        ns: {coll: "tailable2", db: "test"},
        operationType: "insert",
    });

    // Wait for insert shell to terminate.
    insertshell();

    jsTestLog("Testing awaitdata - no wake on insert to another collection");
    res = assert.commandWorked(db.runCommand({
        aggregate: "tailable3",
        pipeline: [{$changeNotification: {}}, oplogProjection],
        cursor: {}
    }));
    aggcursor = res.cursor;
    // We should get a valid cursor.
    assert.neq(aggcursor.id, 0);

    // Initial batch size should be zero as there should be no data.
    assert.eq(aggcursor.firstBatch.length, 0);

    // Now insert something in a different collection in parallel while waiting.
    insertshell = startParallelShell(function() {
        // Wait for the getMore to appear in currentop.
        assert.soon(function() {
            return db.currentOp({op: "getmore", "command.collection": "tailable3"}).inprog.length ==
                1;
        });
        assert.writeOK(db.tailable3a.insert({_id: 103, a: 2}));
    });
    let start = new Date();
    res = assert.commandWorked(
        db.runCommand({getMore: aggcursor.id, collection: "tailable3", maxTimeMS: 1000}));
    let diff = (new Date()).getTime() - start.getTime();
    assert.gt(diff, 900, "AwaitData returned prematurely on insert to unrelated collection.");
    aggcursor = res.cursor;
    // Cursor should be valid with no data.
    assert.neq(aggcursor.id, 0);
    assert.eq(aggcursor.nextBatch.length, 0);

    // Wait for insert shell to terminate.
    insertshell();

    // This time, put something in a different collection, then in the correct collection.
    // We should wake up with just the correct data.
    insertshell = startParallelShell(function() {
        // Wait for the getMore to appear in currentop.
        assert.soon(function() {
            return db.currentOp({op: "getmore", "command.collection": "tailable3"}).inprog.length ==
                1;
        });
        assert.writeOK(db.tailable3a.insert({_id: 104, a: 2}));
        assert(db.currentOp({op: "getmore", "command.collection": "tailable3"}).inprog.length == 1);
        assert.writeOK(db.tailable3.insert({_id: 105, a: 3}));
    });
    res = assert.commandWorked(
        db.runCommand({getMore: aggcursor.id, collection: "tailable3", maxTimeMS: 5 * 60 * 1000}));
    aggcursor = res.cursor;
    assert.neq(aggcursor.id, 0);
    assert.eq(aggcursor.nextBatch.length, 1);
    assert.docEq(aggcursor.nextBatch[0], {
        _id: {
            _id: 105,
            ns: "test.tailable3",
        },
        documentKey: {_id: 105},
        fullDocument: {_id: 105, a: 3},
        ns: {coll: "tailable3", db: "test"},
        operationType: "insert",
    });

    // Wait for insert shell to terminate.
    insertshell();

    jsTestLog("Ensuring attempt to read with legacy operations fails.");
    db.getMongo().forceReadMode('legacy');
    tailableCursor = db.tailable2.aggregate([{$changeNotification: {}}, oplogProjection],
                                            {cursor: {batchSize: 0}});
    assert.throws(function() {
        tailableCursor.next();
    }, [], "Legacy getMore expected to fail on changeNotification cursor.");

    replTest.stopSet();
}());
