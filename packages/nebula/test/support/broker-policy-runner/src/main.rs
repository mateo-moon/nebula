use std::io::{self, Read};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut batch = String::new();
    io::stdin().read_to_string(&mut batch)?;
    let cases: Vec<serde_json::Value> = serde_json::from_str(&batch)?;
    for case in cases {
        let mut engine = regorus::Engine::new();
        engine.set_rego_v0(false);
        engine.set_strict_builtin_errors(true);
        engine.add_policy(
            "generated.rego".into(),
            case["policy"].as_str().unwrap().into(),
        )?;
        engine.set_input_json(&case["input"].to_string())?;
        engine.add_data_json(
            &case
                .get("data")
                .cloned()
                .unwrap_or(serde_json::json!({}))
                .to_string(),
        )?;
        let result = engine.eval_rule(case["query"].as_str().unwrap().into())?;
        let value: serde_json::Value = serde_json::from_str(&result.to_json_str()?)?;
        if case["appraise"].as_bool() == Some(true) {
            // Use the actual EAR implementation, not a test's interpretation
            // of the AR4SI numbers or a hard-coded "affirming" status.
            let mut appraisal = ear::Appraisal::new();
            for (name, value) in value.as_object().ok_or("trust claims are not an object")? {
                let claim: i8 = value
                    .as_i64()
                    .ok_or("trust claim is not an integer")?
                    .try_into()?;
                appraisal.trust_vector.mut_by_name(name)?.set(claim);
            }
            appraisal.update_status_from_trust_vector();
            println!("{}", serde_json::to_string(&appraisal)?);
        } else {
            println!("{}", value);
        }
    }
    Ok(())
}
