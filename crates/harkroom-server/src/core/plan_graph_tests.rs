//! TS `shared/test/planGraph.test.ts`(validatePlan·diffDerived)·`server/test/threadPlanItem.test.ts` 를 옮긴 시험.
//! 기대값은 TS 시험의 글자 그대로다.
use super::*;
use crate::core::msg_list::derive_plan;
use serde_json::json;
use std::collections::HashMap;

fn step(id: &str, over: Value) -> Value {
    let mut m =
        obj(&json!({ "id": id, "title": id, "state": "pending", "links": [], "dependsOn": [] }));
    m.extend(obj(&over));
    Value::Object(m)
}
fn group(id: &str, over: Value) -> Value {
    let mut m = obj(&json!({ "id": id, "title": id, "dependsOn": [] }));
    m.extend(obj(&over));
    Value::Object(m)
}
fn plan(groups: Vec<Value>, steps: Vec<Value>) -> Value {
    json!({ "goal": "목표", "groups": groups, "steps": steps })
}
/// TS `errorOf` 의 JSON 글자(`{code,…}`).
fn err(doc: &Value) -> String {
    match validate_plan(doc) {
        Ok(()) => "ok".into(),
        Err(e) => format!("{{{}}}", e.fields_json()),
    }
}
fn n() -> Value {
    json!({})
}

#[test]
fn validate_accepts() {
    assert_eq!(err(&plan(vec![], vec![])), "ok");
    let mixed = plan(
        vec![group("g1", n())],
        vec![
            step("s1", json!({"groupId":"g1"})),
            step("s2", json!({"dependsOn":["g1"]})),
        ],
    );
    assert_eq!(err(&mixed), "ok");
    let cross = plan(
        vec![group("g1", n()), group("g2", json!({"dependsOn":["s1"]}))],
        vec![
            step("s1", json!({"groupId":"g1"})),
            step("s2", json!({"groupId":"g2"})),
            step("s3", json!({"groupId":"g1","dependsOn":["s2"]})),
        ],
    );
    assert_eq!(err(&cross), "ok");
}

#[test]
fn validate_ids_and_refs() {
    assert_eq!(
        err(&plan(vec![group("s1", n())], vec![])),
        r#"{"code":"invalid_id","id":"s1"}"#
    );
    assert_eq!(
        err(&plan(vec![], vec![step("g1", n())])),
        r#"{"code":"invalid_id","id":"g1"}"#
    );
    assert_eq!(
        err(&plan(vec![], vec![step("s0", n())])),
        r#"{"code":"invalid_id","id":"s0"}"#
    );
    assert_eq!(
        err(&plan(vec![], vec![step("s10000", n())])),
        r#"{"code":"invalid_id","id":"s10000"}"#
    );
    assert_eq!(err(&plan(vec![], vec![step("s9999", n())])), "ok");
    assert_eq!(
        err(&plan(vec![], vec![step("s1", n()), step("s1", n())])),
        r#"{"code":"duplicate_id","id":"s1"}"#
    );
    assert_eq!(
        err(&plan(vec![], vec![step("s1", json!({"dependsOn":["s9"]}))])),
        r#"{"code":"unknown_ref","id":"s9","from":"s1"}"#
    );
    assert_eq!(
        err(&plan(vec![], vec![step("s1", json!({"groupId":"g3"}))])),
        r#"{"code":"unknown_ref","id":"g3","from":"s1"}"#
    );
    assert_eq!(
        err(&plan(
            vec![],
            vec![step("s1", n()), step("s2", json!({"groupId":"s1"}))]
        )),
        r#"{"code":"unknown_ref","id":"s1","from":"s2"}"#
    );
    assert_eq!(
        err(&plan(
            vec![group("g1", json!({"dependsOn":["g1"]}))],
            vec![]
        )),
        r#"{"code":"self_ref","id":"g1"}"#
    );
    let linked = plan(
        vec![group("g1", json!({"linkedRootId":"r-child"}))],
        vec![
            step("s1", json!({"groupId":"g1"})),
            step("s2", json!({"groupId":"g1"})),
        ],
    );
    assert_eq!(
        err(&linked),
        r#"{"code":"linked_group_has_steps","id":"g1","stepIds":["s1","s2"]}"#
    );
}

#[test]
fn validate_cycles() {
    let a = plan(
        vec![group("g2", n())],
        vec![
            step("s3", json!({"dependsOn":["g2"]})),
            step("s4", json!({"groupId":"g2","dependsOn":["s3"]})),
        ],
    );
    assert_eq!(
        err(&a),
        r#"{"code":"dependency_cycle","path":["g2","s4","s3","g2"]}"#
    );
    let b = plan(
        vec![
            group("g1", json!({"dependsOn":["g2"]})),
            group("g2", json!({"dependsOn":["g1"]})),
        ],
        vec![],
    );
    assert_eq!(
        err(&b),
        r#"{"code":"dependency_cycle","path":["g1","g2","g1"]}"#
    );
    let c = plan(
        vec![group("g1", n())],
        vec![step("s1", json!({"groupId":"g1","dependsOn":["g1"]}))],
    );
    assert!(err(&c).starts_with(r#"{"code":"dependency_cycle""#));
    let d = plan(
        vec![group("g1", json!({"dependsOn":["s1"]}))],
        vec![step("s1", json!({"groupId":"g1"}))],
    );
    assert!(err(&d).starts_with(r#"{"code":"dependency_cycle""#));
}

#[test]
fn validate_limits() {
    let steps = |k: usize| {
        (1..=k)
            .map(|i| step(&format!("s{i}"), n()))
            .collect::<Vec<_>>()
    };
    let groups = |k: usize| {
        (1..=k)
            .map(|i| group(&format!("g{i}"), n()))
            .collect::<Vec<_>>()
    };
    // 그룹·단계 수에는 상한이 없다(옛 상한 8·40 을 한참 넘겨도 된다).
    assert_eq!(err(&plan(vec![], steps(400))), "ok");
    assert_eq!(err(&plan(groups(80), vec![])), "ok");
    assert_eq!(err(&plan(groups(80), steps(400))), "ok");
    let deps =
        |k: usize| json!({ "dependsOn": (2..2 + k).map(|i| format!("s{i}")).collect::<Vec<_>>() });
    let mut ok = steps(10);
    ok[0] = step("s1", deps(8));
    assert_eq!(err(&plan(vec![], ok)), "ok");
    let mut over = steps(10);
    over[0] = step("s1", deps(9));
    assert_eq!(
        err(&plan(vec![], over)),
        r#"{"code":"limit_exceeded","what":"dependsOn","limit":8,"id":"s1"}"#
    );
    assert_eq!(
        err(&plan(
            vec![],
            vec![step("s1", json!({"title":"🙂".repeat(120)}))]
        )),
        "ok"
    );
    assert_eq!(
        err(&plan(
            vec![],
            vec![step("s1", json!({"title":"a".repeat(121)}))]
        )),
        r#"{"code":"limit_exceeded","what":"title","limit":120,"id":"s1"}"#
    );
    let edge = json!({"goal":"a".repeat(200),"groups":[],"steps":[],"next":"a".repeat(300),"blocked":"a".repeat(300)});
    assert_eq!(err(&edge), "ok");
    let goal = json!({"goal":"a".repeat(201),"groups":[],"steps":[]});
    assert_eq!(
        err(&goal),
        r#"{"code":"limit_exceeded","what":"goal","limit":200}"#
    );
    let links: Vec<Value> = (1..=11)
        .map(|i| json!({"kind":"pr","repo":"o/r","number":i}))
        .collect();
    assert_eq!(
        err(&plan(vec![], vec![step("s1", json!({ "links": links }))])),
        r#"{"code":"limit_exceeded","what":"links","limit":10,"id":"s1"}"#
    );
    // 상한이 id 보다 먼저다.
    assert_eq!(
        err(&plan(
            vec![],
            vec![step("x", json!({"title":"a".repeat(121)}))]
        )),
        r#"{"code":"limit_exceeded","what":"title","limit":120,"id":"x"}"#
    );
}

#[test]
fn diff_derived_new_ready_and_waiting() {
    let mut doc = plan(
        vec![],
        vec![
            step("s1", json!({"state":"active"})),
            step("s2", json!({"dependsOn":["s1"]})),
            step("s3", n()),
        ],
    );
    let none = HashMap::new();
    let before = derive_plan(&doc, &none);
    doc["steps"][0]["state"] = json!("done");
    doc["steps"]
        .as_array_mut()
        .unwrap()
        .push(step("s4", json!({"dependsOn":["s3"]})));
    let after = derive_plan(&doc, &none);
    assert_eq!(
        diff_derived(&before, &after),
        (vec!["s2".to_string()], vec!["s4".to_string()])
    );
    assert_eq!(
        diff_derived(&[], &after).0,
        vec!["s2".to_string(), "s3".to_string()]
    );
}

fn idoc() -> Value {
    json!({
        "goal": "g",
        "groups": [{ "id": "g1", "title": "G", "dependsOn": [] }],
        "steps": [
            { "id": "s1", "title": "a", "state": "pending", "groupId": "g1", "links": [], "dependsOn": [] },
            { "id": "s2", "title": "b", "state": "pending", "links": [{ "kind": "pr", "repo": "o/r", "number": 1 }], "dependsOn": ["s1", "g1"] }
        ]
    })
}
fn ok(r: Result<(Value, String), PlanError>) -> (Value, String) {
    r.unwrap_or_else(|e| panic!("{}", e.fields_json()))
}
fn ierr(r: Result<(Value, String), PlanError>) -> String {
    match r {
        Ok(_) => "ok".into(),
        Err(e) => format!("{{{}}}", e.fields_json()),
    }
}
fn ids(v: &Value) -> Vec<&str> {
    arr(v).iter().map(id_of).collect()
}
fn s(x: &str) -> Option<String> {
    Some(x.to_string())
}

#[test]
fn item_no_plan_and_rev_conflict() {
    let p = ItemPatch {
        title: s("x"),
        ..Default::default()
    };
    assert_eq!(ierr(apply_plan_item(None, &p)), r#"{"code":"no_plan"}"#);
    let d = idoc();
    let p = ItemPatch {
        id: s("s1"),
        state: s("done"),
        if_rev: Some(2),
        ..Default::default()
    };
    assert_eq!(
        ierr(apply_plan_item(Some((&d, 3)), &p)),
        r#"{"code":"rev_conflict","rev":3}"#
    );
    let p = ItemPatch {
        id: s("s1"),
        state: s("done"),
        if_rev: Some(3),
        ..Default::default()
    };
    assert_eq!(
        ok(apply_plan_item(Some((&d, 3)), &p)).0["steps"][0]["state"],
        "done"
    );
}

#[test]
fn item_add_picks_next_id_and_place() {
    let d = idoc();
    let (doc, id) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            title: s("c"),
            after: Some(s("s1")),
            ..Default::default()
        },
    ));
    assert_eq!(id, "s3");
    assert_eq!(ids(&doc["steps"]), ["s1", "s3", "s2"]);
    assert_eq!(
        doc["steps"][1],
        json!({"id":"s3","title":"c","state":"pending","links":[],"dependsOn":[]})
    );
    let (doc, id) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            type_: s("group"),
            title: s("H"),
            after: Some(None),
            ..Default::default()
        },
    ));
    assert_eq!(id, "g2");
    assert_eq!(ids(&doc["groups"]), ["g2", "g1"]);
    // after 생략: 새 노드는 맨 뒤, 있던 노드는 제자리.
    let (doc, _) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            title: s("z"),
            ..Default::default()
        },
    ));
    assert_eq!(ids(&doc["steps"]), ["s1", "s2", "s3"]);
    let (doc, _) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            id: s("s1"),
            title: s("A"),
            ..Default::default()
        },
    ));
    assert_eq!(ids(&doc["steps"]), ["s1", "s2"]);
    // 있던 노드를 옮김.
    let (doc, _) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            id: s("s1"),
            after: Some(s("s2")),
            ..Default::default()
        },
    ));
    assert_eq!(ids(&doc["steps"]), ["s2", "s1"]);
}

#[test]
fn item_edit_keeps_other_fields_and_nodes() {
    let d = idoc();
    let (doc, _) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            id: s("s2"),
            state: s("active"),
            ..Default::default()
        },
    ));
    let mut want = d["steps"][1].clone();
    want["state"] = json!("active");
    assert_eq!(doc["steps"][1], want);
    assert_eq!(doc["steps"][0], d["steps"][0]);
    assert_eq!(doc["goal"], "g");
    assert_eq!(d["steps"][1]["state"], "pending");
    // null 은 칸을 null 로 남긴다(undefined 와 다르다).
    let (doc, _) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            id: s("s1"),
            group_id: Some(None),
            ..Default::default()
        },
    ));
    assert_eq!(doc["steps"][0]["groupId"], Value::Null);
    assert!(doc["steps"][0].as_object().unwrap().contains_key("groupId"));
}

#[test]
fn item_depends_on() {
    let d = idoc();
    let deps = |p: ItemPatch, i: usize| {
        ok(apply_plan_item(Some((&d, 1)), &p)).0["steps"][i]["dependsOn"].clone()
    };
    assert_eq!(
        deps(
            ItemPatch {
                id: s("s2"),
                remove_depends_on: Some(vec!["g1".into()]),
                ..Default::default()
            },
            1
        ),
        json!(["s1"])
    );
    assert_eq!(
        deps(
            ItemPatch {
                id: s("s1"),
                add_depends_on: Some(vec!["s2".into()]),
                ..Default::default()
            },
            0
        ),
        json!(["s2"])
    );
    assert_eq!(
        deps(
            ItemPatch {
                id: s("s2"),
                depends_on: Some(vec![]),
                ..Default::default()
            },
            1
        ),
        json!([])
    );
    let both = ItemPatch {
        id: s("s2"),
        depends_on: Some(vec!["g1".into()]),
        add_depends_on: Some(vec!["s1".into(), "g1".into()]),
        remove_depends_on: Some(vec!["g1".into()]),
        ..Default::default()
    };
    assert_eq!(deps(both, 1), json!(["s1"]));
}

#[test]
fn item_links() {
    let d = idoc();
    let p = ItemPatch {
        id: s("s2"),
        add_links: Some(vec![json!({"kind":"pr","repo":"O/R","number":1})]),
        ..Default::default()
    };
    assert_eq!(
        ok(apply_plan_item(Some((&d, 1)), &p)).0["steps"][1]["links"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let p = ItemPatch {
        id: s("s2"),
        remove_links: Some(vec![json!({"kind":"pr","repo":"o/r","number":1})]),
        ..Default::default()
    };
    assert_eq!(
        ok(apply_plan_item(Some((&d, 1)), &p)).0["steps"][1]["links"],
        json!([])
    );
    let m = "0F8FAD5B-D9CB-469F-A165-70867728950E";
    let p = ItemPatch {
        id: s("s2"),
        add_links: Some(vec![
            json!({"kind":"message","id":m}),
            json!({"kind":"message","id":m.to_lowercase()}),
        ]),
        ..Default::default()
    };
    assert_eq!(
        ok(apply_plan_item(Some((&d, 1)), &p)).0["steps"][1]["links"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn item_remove() {
    let d = idoc();
    let (doc, id) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            id: s("s1"),
            remove: Some(true),
            ..Default::default()
        },
    ));
    assert_eq!(id, "s1");
    assert_eq!(ids(&doc["steps"]), ["s2"]);
    assert_eq!(doc["steps"][0]["dependsOn"], json!(["g1"]));
    let (doc, _) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            type_: s("group"),
            id: s("g1"),
            remove: Some(true),
            ..Default::default()
        },
    ));
    assert_eq!(doc["groups"], json!([]));
    let rows: Vec<Value> = arr(&doc["steps"])
        .iter()
        .map(|x| json!([x["id"], x["groupId"], x["dependsOn"]]))
        .collect();
    assert_eq!(
        rows,
        vec![json!(["s1", null, []]), json!(["s2", null, ["s1"]])]
    );
    // s2 는 groupId 칸이 원래 없었다 — 새로 만들지 않는다.
    assert!(!doc["steps"][1].as_object().unwrap().contains_key("groupId"));
    // id 머리가 g 면 type 없이도 그룹이다.
    let (doc, _) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            id: s("g1"),
            remove: Some(true),
            ..Default::default()
        },
    ));
    assert_eq!(doc["groups"], json!([]));
    assert_eq!(
        ierr(apply_plan_item(
            Some((&d, 1)),
            &ItemPatch {
                id: s("s9"),
                remove: Some(true),
                ..Default::default()
            }
        )),
        r#"{"code":"unknown_item","id":"s9"}"#
    );
    assert_eq!(
        ierr(apply_plan_item(
            Some((&d, 1)),
            &ItemPatch {
                remove: Some(true),
                ..Default::default()
            }
        )),
        r#"{"code":"unknown_item","id":""}"#
    );
    // remove: false 는 지우기가 아니다.
    let (doc, _) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            id: s("s1"),
            remove: Some(false),
            ..Default::default()
        },
    ));
    assert_eq!(ids(&doc["steps"]), ["s1", "s2"]);
}

#[test]
fn item_rejections() {
    let d = idoc();
    let e = |p: ItemPatch| ierr(apply_plan_item(Some((&d, 1)), &p));
    assert_eq!(
        e(ItemPatch {
            id: s("s9"),
            state: s("done"),
            ..Default::default()
        }),
        r#"{"code":"unknown_item","id":"s9"}"#
    );
    assert_eq!(
        e(ItemPatch {
            type_: s("group"),
            id: s("g1"),
            state: s("done"),
            ..Default::default()
        }),
        r#"{"code":"field_not_for_type","field":"state","type":"group"}"#
    );
    assert_eq!(
        e(ItemPatch {
            id: s("s1"),
            linked_root_id: Some(None),
            ..Default::default()
        }),
        r#"{"code":"field_not_for_type","field":"linkedRootId","type":"step"}"#
    );
    assert_eq!(
        e(ItemPatch {
            state: s("done"),
            ..Default::default()
        }),
        r#"{"code":"title_required"}"#
    );
    assert_eq!(
        e(ItemPatch {
            title: s("x"),
            after: Some(s("s9")),
            ..Default::default()
        }),
        r#"{"code":"unknown_item","id":"s9"}"#
    );
    assert_eq!(
        e(ItemPatch {
            id: s("s1"),
            manager_id: Some(None),
            ..Default::default()
        }),
        r#"{"code":"field_not_for_type","field":"managerId","type":"step"}"#
    );
    // 그룹 칸 검사는 STEP_ONLY 순서(groupId 가 state 보다 앞).
    assert_eq!(
        e(ItemPatch {
            type_: s("group"),
            id: s("g1"),
            state: s("done"),
            group_id: Some(None),
            ..Default::default()
        }),
        r#"{"code":"field_not_for_type","field":"groupId","type":"group"}"#
    );
}

#[test]
fn item_plan_type() {
    let d = idoc();
    let (doc, id) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            type_: s("plan"),
            manager_id: Some(s("a-1")),
            if_rev: Some(1),
            ..Default::default()
        },
    ));
    assert_eq!(id, "plan");
    assert_eq!(doc["managerId"], "a-1");
    assert_eq!(doc["steps"], d["steps"]);
    let (doc, _) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            type_: s("plan"),
            manager_id: Some(None),
            ..Default::default()
        },
    ));
    assert_eq!(doc["managerId"], Value::Null);
    let e = |p: ItemPatch| ierr(apply_plan_item(Some((&d, 1)), &p));
    assert_eq!(
        e(ItemPatch {
            type_: s("plan"),
            ..Default::default()
        }),
        r#"{"code":"manager_required"}"#
    );
    // 첫 칸은 zod 키 순서다(id 가 title 보다 앞).
    assert_eq!(
        e(ItemPatch {
            type_: s("plan"),
            title: s("x"),
            id: s("s1"),
            manager_id: Some(None),
            ..Default::default()
        }),
        r#"{"code":"field_not_for_type","field":"id","type":"plan"}"#
    );
    assert_eq!(
        e(ItemPatch {
            type_: s("plan"),
            remove: Some(false),
            ..Default::default()
        }),
        r#"{"code":"field_not_for_type","field":"remove","type":"plan"}"#
    );
}

#[test]
fn seq_never_reuses_ids() {
    let d = idoc();
    let (removed, _) = ok(apply_plan_item(
        Some((&d, 1)),
        &ItemPatch {
            id: s("s2"),
            remove: Some(true),
            ..Default::default()
        },
    ));
    let (ss, gg) = plan_seq(Some(&d), &removed);
    assert_eq!((ss, gg), (2, 1));
    let mut stamped = removed.clone();
    stamped["seq"] = json!({ "s": ss, "g": gg });
    assert_eq!(
        ok(apply_plan_item(
            Some((&stamped, 2)),
            &ItemPatch {
                title: s("새 단계"),
                ..Default::default()
            }
        ))
        .1,
        "s3"
    );
    let mut no_groups = stamped.clone();
    no_groups["groups"] = json!([]);
    for st in no_groups["steps"].as_array_mut().unwrap() {
        st["groupId"] = Value::Null;
    }
    let p = ItemPatch {
        type_: s("group"),
        title: s("H"),
        ..Default::default()
    };
    assert_eq!(ok(apply_plan_item(Some((&no_groups, 2)), &p)).1, "g2");
    let mut prev = idoc();
    prev["seq"] = json!({ "s": 9, "g": 4 });
    assert_eq!(
        plan_seq(Some(&prev), &json!({"goal":"g","groups":[],"steps":[]})),
        (9, 4)
    );
    assert_eq!(plan_seq(None, &idoc()), (2, 1));
    // 새 판의 seq 도 센다.
    assert_eq!(
        plan_seq(
            None,
            &json!({"goal":"g","groups":[],"steps":[],"seq":{"s":7,"g":0}})
        ),
        (7, 0)
    );
}

#[test]
fn texts_for_scan() {
    let d = json!({
        "goal": "목표", "next": null, "blocked": "막힘",
        "groups": [{ "id": "g1", "title": "G", "dependsOn": [] }],
        "steps": [{ "id": "s1", "title": "a", "state": "blocked", "links": [], "dependsOn": [], "blockedReason": "왜" },
                  { "id": "s2", "title": "b", "state": "pending", "links": [], "dependsOn": [] }]
    });
    assert_eq!(
        plan_texts(&d),
        ["목표", "", "막힘", "G", "a", "왜", "b", ""]
    );
}
