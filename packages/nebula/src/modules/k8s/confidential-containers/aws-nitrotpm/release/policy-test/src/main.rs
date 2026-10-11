use std::io::{self, Read};
use std::num::{NonZeroU32, NonZeroUsize};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let cases: Vec<serde_json::Value> = serde_json::from_str(&input)?;
    for case in cases {
        // Match src/agent/policy/src/policy.rs in the pinned Kata tree.
        let mut engine = regorus::Engine::new();
        engine.set_strict_builtin_errors(false);
        engine.set_gather_prints(true);
        engine.set_policy_length_config(regorus::PolicyLengthConfig {
            max_col: NonZeroU32::new(64 * 1024).unwrap(),
            max_file_bytes: NonZeroUsize::new(16 * 1024 * 1024).unwrap(),
            max_lines: NonZeroUsize::new(200_000).unwrap(),
        });
        engine.add_policy(
            "policy.rego".into(),
            case["policy"].as_str().ok_or("missing policy")?.into(),
        )?;
        engine.set_input_json(&case["input"].to_string())?;
        engine.add_data_json(&case["data"].to_string())?;
        let value = engine.eval_rule(case["query"].as_str().ok_or("missing query")?.into())?;
        let value: serde_json::Value = serde_json::from_str(&value.to_json_str()?)?;
        println!("{value}");
    }
    Ok(())
}
