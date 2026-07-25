use crate::features::jobs::JobFormat;

#[test]
fn job_formats_expose_resume_limits_explicitly() {
    assert!(JobFormat::Csv.resumable());
    assert!(JobFormat::Ndjson.resumable());
    assert!(!JobFormat::Xlsx.resumable());
    assert!(!JobFormat::CsvGzip.resumable());
    assert_eq!(JobFormat::CsvGzip.base(), JobFormat::Csv);
}
