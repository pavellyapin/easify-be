sam local invoke GenerateCourseFunction --event course-event.json

sam local invoke GenerateWorkoutsBatchFunction --event workouts-event.json

sam local invoke GenerateCareersBatchFunction --event industry-event.json

sam local invoke GenerateFinancialPlansBatchFunction --event mocks/financial-plans-event.json